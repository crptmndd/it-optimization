import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin } from "../auth/guard.js";
import { processUpload, SLOTS, type AssetSlot } from "../assets/images.js";
import { CASES_SCOPE, bumpRevision, currentRevision, prisma } from "../db.js";
import { env } from "../env.js";
import { replaceCasesBody, toDto } from "./dto.js";

const WITH_ASSETS = { assets: true } as const;

/** Кейсы в порядке показа. Удалённые (soft delete) не отдаются. */
async function listCases() {
  const items = await prisma.case.findMany({
    where: { deletedAt: null },
    orderBy: { position: "asc" },
    include: WITH_ASSETS,
  });
  return items.map(toDto);
}

export async function caseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/cases", { preHandler: requireAdmin }, async (_request, reply) => {
    const [cases, version] = await Promise.all([listCases(), currentRevision()]);
    return reply.send({ cases, version: String(version) });
  });

  /**
   * Заменяет весь список разом: панель редактирует его целиком, и порядок —
   * такое же свойство контента, как заголовок. Пришедшие id создаются или
   * обновляются, пропавшие помечаются удалёнными.
   */
  app.put("/cases", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = replaceCasesBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Некорректные данные",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { cases, version } = parsed.data;

    const slugs = new Set<string>();
    for (const item of cases) {
      if (slugs.has(item.slug)) {
        return reply.code(400).send({ error: `Адрес «${item.slug}» повторяется` });
      }
      slugs.add(item.slug);
    }

    const actual = await currentRevision();
    if (String(actual) !== version) {
      return reply.code(409).send({
        error:
          "Контент успели изменить в другом окне или на другом устройстве. Обнови страницу и внеси правки заново.",
        version: String(actual),
      });
    }

    const before = await listCases();

    const nextVersion = await prisma.$transaction(async (tx) => {
      const keptIds = cases.map((item) => item.id);

      for (const [index, item] of cases.entries()) {
        await tx.case.upsert({
          where: { id: item.id },
          create: {
            id: item.id,
            slug: item.slug,
            status: item.status,
            title: item.title,
            description: item.description,
            quote: item.quote,
            tags: item.tags,
            services: item.services ?? [],
            position: index,
          },
          update: {
            slug: item.slug,
            status: item.status,
            title: item.title,
            description: item.description,
            quote: item.quote,
            tags: item.tags,
            // Поля нет в запросе — оставляем то, что уже в базе. Иначе клиент
            // старой версии обнуляет привязку к услугам у всех кейсов разом.
            ...(item.services !== undefined ? { services: item.services } : {}),
            position: index,
            deletedAt: null,
          },
        });
      }

      // Мягкое удаление: кейс уходит с сайта, но остаётся в базе и в журнале.
      await tx.case.updateMany({
        where: { id: { notIn: keptIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      const row = await tx.contentRevision.upsert({
        where: { scope: CASES_SCOPE },
        update: { value: { increment: 1 } },
        create: { scope: CASES_SCOPE, value: 1 },
      });
      return row.value;
    });

    const after = await listCases();
    await audit(request, {
      entity: "cases",
      action: "replace",
      diff: {
        before: before.map((item) => item.slug),
        after: after.map((item) => item.slug),
      },
    });

    return reply.send({ cases: after, version: String(nextVersion) });
  });

  const assetParams = z.object({
    caseId: z.string().uuid(),
    slot: z.enum(["cover", "detail", "detail_mobile"]),
  });

  /**
   * Загрузка картинки для конкретного кейса. Файл не сохраняется как есть:
   * он пересобирается через sharp в тот WebP, который ждёт вёрстка.
   */
  app.post(
    "/cases/:caseId/assets/:slot",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = assetParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Неизвестный слот картинки" });
      }
      const { caseId, slot } = params.data;

      const target = await prisma.case.findFirst({
        where: { id: caseId, deletedAt: null },
      });
      if (!target) return reply.code(404).send({ error: "Кейс не найден" });

      const file = await request.file({ limits: { fileSize: env.MAX_UPLOAD_BYTES } });
      if (!file) return reply.code(400).send({ error: "Файл не приложен" });

      let raw: Buffer;
      try {
        raw = await file.toBuffer();
      } catch {
        return reply.code(413).send({
          error: `Файл больше ${Math.round(env.MAX_UPLOAD_BYTES / 1024 / 1024)} МБ`,
        });
      }

      let processed;
      try {
        processed = await processUpload(raw, slot as AssetSlot, target.slug);
      } catch (cause) {
        request.log.warn({ cause }, "не удалось обработать картинку");
        return reply
          .code(415)
          .send({ error: "Не похоже на картинку — поддерживаются PNG, JPEG и WebP" });
      }

      const asset = await prisma.caseAsset.upsert({
        where: { caseId_slot: { caseId, slot } },
        create: {
          caseId,
          slot,
          path: processed.path,
          hash: processed.hash,
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes,
        },
        update: {
          path: processed.path,
          hash: processed.hash,
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes,
        },
      });

      const version = await bumpRevision();
      await audit(request, {
        entity: "case_assets",
        entityId: caseId,
        action: "upload",
        diff: { slot, path: asset.path, bytes: asset.bytes },
      });

      return reply.send({
        asset: {
          slot,
          path: asset.path,
          hash: asset.hash,
          width: asset.width,
          height: asset.height,
          bytes: asset.bytes,
        },
        version: String(version),
      });
    },
  );

  app.get("/cases/slots", { preHandler: requireAdmin }, async (_request, reply) =>
    reply.send({
      slots: Object.entries(SLOTS).map(([slot, spec]) => ({
        slot,
        width: spec.width,
        height: spec.height,
        fit: spec.fit,
      })),
    }),
  );
}
