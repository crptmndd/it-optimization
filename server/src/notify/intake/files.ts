import { auditAs } from "../../audit.js";
import { MAX_ATTACHMENTS, saveAttachment } from "../../crm/tasks/attachments.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { downloadFile, type TgFile, type TgMessage } from "../telegram.js";
import type { Log } from "./cards.js";

/**
 * Файлы из сообщений в задачу: скриншот бага, документ от клиента, короткое видео. Без
 * этого бот писал «[фото]», а сам скриншот оставался в переписке, и исполнитель искал
 * его по чатам. Голосовые не прикладываются: их текст уже в задаче.
 */

/** Ботам телеграм отдаёт файлы до 20 МБ; свой потолок — тот же, что у загрузки в CRM. */
const LIMIT = Math.min(20 * 1024 * 1024, env.MAX_UPLOAD_BYTES);

export interface IncomingFile {
  file: TgFile;
  name: string;
  mime: string;
}

function fromMessage(message: TgMessage): IncomingFile[] {
  const files: IncomingFile[] = [];
  // Телеграм присылает фото в нескольких размерах, последний — самый крупный.
  const photo = message.photo?.at(-1);
  if (photo) {
    files.push({
      file: photo,
      name: `фото-${message.message_id}.jpg`,
      mime: "image/jpeg",
    });
  }
  if (message.document) {
    files.push({
      file: message.document,
      name: message.document.file_name ?? `файл-${message.message_id}`,
      mime: message.document.mime_type ?? "application/octet-stream",
    });
  }
  if (message.video) {
    files.push({
      file: message.video,
      name: message.video.file_name ?? `видео-${message.message_id}.mp4`,
      mime: message.video.mime_type ?? "video/mp4",
    });
  }
  return files;
}

/**
 * Файлы пачки. Сообщение, на которое ответили командой `/task` в общем чате, тоже в счёт:
 * «/task» в ответ на скриншот — это «поставь задачу вот по этому».
 */
export function filesOf(messages: TgMessage[], botId: number | null): IncomingFile[] {
  const files = messages.flatMap(fromMessage);
  const quoted = messages
    .map((message) => message.reply_to_message)
    .find((reply) => reply && reply.from?.id !== botId);
  return quoted ? [...fromMessage(quoted), ...files] : files;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

/** Сохранить файлы в задачу. Сбой одного не мешает остальным и не отменяет задачу. */
export async function attachFiles(
  taskId: string,
  files: IncomingFile[],
  userId: string,
  log: Log,
): Promise<{ saved: number; problems: string[] }> {
  const problems: string[] = [];
  if (files.length === 0) return { saved: 0, problems };

  let room = MAX_ATTACHMENTS - (await prisma.taskAttachment.count({ where: { taskId } }));
  let saved = 0;
  for (const item of files) {
    if (room <= 0) {
      problems.push(
        `У задачи уже ${MAX_ATTACHMENTS} файлов, «${item.name}» не прикреплён.`,
      );
      continue;
    }
    if (item.file.file_size && item.file.file_size > LIMIT) {
      problems.push(`«${item.name}» больше ${megabytes(LIMIT)}, не прикреплён.`);
      continue;
    }
    try {
      const bytes = await downloadFile(item.file.file_id, LIMIT);
      await saveAttachment({
        taskId,
        fileName: item.name,
        mimeType: item.mime,
        bytes,
        createdById: userId,
      });
      saved += 1;
      room -= 1;
    } catch (cause) {
      log.warn({ err: cause }, "файл из телеграма не сохранился");
      problems.push(`«${item.name}» не сохранился.`);
    }
  }

  if (saved > 0) {
    await auditAs(
      userId,
      {
        entity: "tasks",
        entityId: taskId,
        action: "attach",
        diff: { via: "telegram", saved },
      },
      log,
    );
  }
  return { saved, problems };
}
