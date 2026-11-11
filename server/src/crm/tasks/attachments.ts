import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { TaskAttachment } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import type { Viewer } from "../access.js";
import { invalidInput } from "../http.js";
import { INLINE_TYPES, toAttachmentDto } from "./attachment-dto.js";
import { reachableTask } from "./service.js";

/**
 * Вложения задач: скриншоты, документы, файлы от клиента. Чаще всего приходят из
 * телеграма вместе с поручением, но прикрепить можно и в окне задачи.
 *
 * Файл лежит в `UPLOAD_DIR/attachments` под случайным именем: исходное бывает каким
 * угодно, и в путь на диске его пускать нельзя. Каталог — тот же том `uploads`, что
 * снимает `backup.sh`, поэтому вложения попадают в ночной бэкап вместе с картинками.
 * Отдаются файлы только через API и только тем, кому видна задача: в них бывают данные
 * клиентов, а публичная ссылка разошлась бы дальше команды.
 */

export const MAX_ATTACHMENTS = 50;

function directory(): string {
  return join(env.UPLOAD_DIR, "attachments");
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
};

/** Расширение только из букв и цифр: имя на диске не должно нести ничего от присланного. */
function extensionOf(fileName: string, mimeType: string): string {
  const fromName = extname(fileName).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXTENSIONS[mimeType] ?? "";
}

/** Имя для человека: без путей и управляющих символов, они ломают заголовок ответа. */
function cleanName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return clean || "файл";
}

export async function saveAttachment(input: {
  taskId: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  createdById: string | null;
}): Promise<TaskAttachment> {
  const fileName = cleanName(input.fileName);
  const mimeType =
    input.mimeType.toLowerCase().slice(0, 100) || "application/octet-stream";
  const storageKey = `${randomUUID()}${extensionOf(fileName, mimeType)}`;
  await mkdir(directory(), { recursive: true });
  const path = join(directory(), storageKey);
  await writeFile(path, input.bytes);
  try {
    return await prisma.taskAttachment.create({
      data: {
        taskId: input.taskId,
        fileName,
        mimeType,
        size: input.bytes.length,
        storageKey,
        createdById: input.createdById,
      },
    });
  } catch (cause) {
    // Записи нет — и файлу незачем лежать: иначе он ждал бы ночной уборки.
    await unlink(path).catch(() => {});
    throw cause;
  }
}

/**
 * Ночная уборка: файлы без записи. Запись исчезает вместе с задачей — по каскаду, когда
 * Корзина удаляет задачу насовсем, — а файл на диске каскад не видит. Свежие не трогаем:
 * между записью файла и строкой в базе проходит миг, и этот миг не должен стоить файла.
 */
export async function purgeOrphanAttachments(): Promise<number> {
  let files: string[];
  try {
    files = await readdir(directory());
  } catch {
    return 0;
  }
  const known = new Set(
    (await prisma.taskAttachment.findMany({ select: { storageKey: true } })).map(
      (row) => row.storageKey,
    ),
  );
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of files) {
    if (known.has(file)) continue;
    const path = join(directory(), file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.mtimeMs > dayAgo) continue;
    await unlink(path).catch(() => {});
    removed += 1;
  }
  return removed;
}

/** Задача, к которой человек может прикреплять и смотреть файлы: та же видимость, что в CRM. */
async function canSee(taskId: string, viewer: Viewer): Promise<boolean> {
  return (await prisma.task.count({ where: reachableTask(taskId, viewer) })) > 0;
}

const taskParams = z.object({ id: z.string().uuid() });
const fileParams = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

/** RFC 5987: кириллица в имени файла едет только так, иначе заголовок отвергнут. */
function disposition(kind: "inline" | "attachment", fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/tasks/:id/attachments/:attachmentId",
    { preHandler: requireTeam },
    async (request, reply) => {
      const params = fileParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);
      const { id, attachmentId } = params.data;

      if (!(await canSee(id, request.user!))) {
        return reply.code(404).send({ error: "Задача не найдена" });
      }
      const row = await prisma.taskAttachment.findFirst({
        where: { id: attachmentId, taskId: id },
      });
      if (!row) return reply.code(404).send({ error: "Файл не найден" });

      const path = join(directory(), row.storageKey);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) return reply.code(404).send({ error: "Файл не найден" });

      const inline = INLINE_TYPES.has(row.mimeType);
      reply
        .header("Content-Type", inline ? row.mimeType : "application/octet-stream")
        .header("Content-Length", info.size)
        .header(
          "Content-Disposition",
          disposition(inline ? "inline" : "attachment", row.fileName),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, max-age=3600");
      // Картинка, открытая во вкладке, ничего не исполнит и никуда не сходит. PDF без этого:
      // песочница выключает встроенный просмотрщик, и файл открывался бы пустым.
      if (row.mimeType.startsWith("image/")) {
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        );
      }
      return reply.send(createReadStream(path));
    },
  );

  app.post(
    "/tasks/:id/attachments",
    { preHandler: requireTeam },
    async (request, reply) => {
      const params = taskParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);
      const { id } = params.data;

      if (!(await canSee(id, request.user!))) {
        return reply.code(404).send({ error: "Задача не найдена" });
      }
      const count = await prisma.taskAttachment.count({ where: { taskId: id } });
      if (count >= MAX_ATTACHMENTS) {
        return reply.code(409).send({ error: `У задачи уже ${MAX_ATTACHMENTS} файлов` });
      }

      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES } });
      if (!file) return reply.code(400).send({ error: "Файл не приложен" });
      let bytes: Buffer;
      try {
        bytes = await file.toBuffer();
      } catch {
        return reply.code(413).send({
          error: `Файл больше ${Math.round(env.MAX_UPLOAD_BYTES / 1024 / 1024)} МБ`,
        });
      }

      const row = await saveAttachment({
        taskId: id,
        fileName: file.filename,
        mimeType: file.mimetype,
        bytes,
        createdById: request.user!.id,
      });
      await audit(request, {
        entity: "tasks",
        entityId: id,
        action: "attach",
        diff: { fileName: row.fileName, size: row.size },
      });
      return reply.code(201).send({ attachment: toAttachmentDto(row) });
    },
  );

  app.delete(
    "/tasks/:id/attachments/:attachmentId",
    { preHandler: requireTeam },
    async (request, reply) => {
      const params = fileParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);
      const { id, attachmentId } = params.data;

      if (!(await canSee(id, request.user!))) {
        return reply.code(404).send({ error: "Задача не найдена" });
      }
      const row = await prisma.taskAttachment.findFirst({
        where: { id: attachmentId, taskId: id },
      });
      if (!row) return reply.code(404).send({ error: "Файл не найден" });

      await prisma.taskAttachment.delete({ where: { id: row.id } });
      await unlink(join(directory(), row.storageKey)).catch(() => {});
      await audit(request, {
        entity: "tasks",
        entityId: id,
        action: "detach",
        diff: { fileName: row.fileName },
      });
      return reply.code(204).send();
    },
  );
}
