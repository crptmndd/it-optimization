import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin } from "../auth/guard.js";
import { BLOG_COVER, processCover } from "../assets/images.js";
import { POSTS_SCOPE, bumpRevision, currentRevision, prisma } from "../db.js";
import { env } from "../env.js";
import { replacePostsBody, toDto } from "./dto.js";

/** Статьи в порядке показа в блоге. Удалённые (soft delete) не отдаются. */
async function listPosts() {
  const items = await prisma.post.findMany({
    where: { deletedAt: null },
    orderBy: { position: "asc" },
  });
  return items.map(toDto);
}

/** «2026-07-18» → полночь UTC. Дата публикации — день, а не момент времени. */
function toDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export async function postRoutes(app: FastifyInstance): Promise<void> {
  app.get("/posts", { preHandler: requireAdmin }, async (_request, reply) => {
    const [posts, version] = await Promise.all([
      listPosts(),
      currentRevision(POSTS_SCOPE),
    ]);
    return reply.send({ posts, version: String(version) });
  });

  /**
   * Заменяет весь список разом — как и у кейсов: панель редактирует блог
   * целиком, и порядок статей такое же свойство контента, как заголовок.
   * Пришедшие id создаются или обновляются, пропавшие помечаются удалёнными.
   */
  app.put("/posts", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = replacePostsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Некорректные данные",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { posts, version } = parsed.data;

    const slugs = new Set<string>();
    for (const item of posts) {
      if (slugs.has(item.slug)) {
        return reply.code(400).send({ error: `Адрес «${item.slug}» повторяется` });
      }
      slugs.add(item.slug);
    }

    const actual = await currentRevision(POSTS_SCOPE);
    if (String(actual) !== version) {
      return reply.code(409).send({
        error:
          "Блог успели изменить в другом окне или на другом устройстве. Обнови страницу и внеси правки заново.",
        version: String(actual),
      });
    }

    const before = await listPosts();

    const nextVersion = await prisma.$transaction(async (tx) => {
      const keptIds = posts.map((item) => item.id);

      for (const [index, item] of posts.entries()) {
        const sections = item.sections as unknown as Prisma.InputJsonValue;
        await tx.post.upsert({
          where: { id: item.id },
          create: {
            id: item.id,
            slug: item.slug,
            status: item.status,
            title: item.title,
            excerpt: item.excerpt,
            category: item.category,
            lead: item.lead,
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
            readingTime: item.readingTime,
            sections,
            takeaways: item.takeaways,
            services: item.services ?? [],
            publishedAt: toDate(item.publishedAt),
            position: index,
          },
          update: {
            slug: item.slug,
            status: item.status,
            title: item.title,
            excerpt: item.excerpt,
            category: item.category,
            lead: item.lead,
            metaTitle: item.metaTitle,
            metaDescription: item.metaDescription,
            readingTime: item.readingTime,
            sections,
            takeaways: item.takeaways,
            // Поля нет в запросе — оставляем то, что уже в базе (как у кейсов):
            // клиент старой версии не должен обнулять привязку к услугам.
            ...(item.services !== undefined ? { services: item.services } : {}),
            publishedAt: toDate(item.publishedAt),
            position: index,
            deletedAt: null,
          },
        });
      }

      // Мягкое удаление: статья уходит с сайта, но остаётся в базе и в журнале.
      await tx.post.updateMany({
        where: { id: { notIn: keptIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      const row = await tx.contentRevision.upsert({
        where: { scope: POSTS_SCOPE },
        update: { value: { increment: 1 } },
        create: { scope: POSTS_SCOPE, value: 1 },
      });
      return row.value;
    });

    const after = await listPosts();
    await audit(request, {
      entity: "posts",
      action: "replace",
      diff: {
        before: before.map((item) => item.slug),
        after: after.map((item) => item.slug),
      },
    });

    return reply.send({ posts: after, version: String(nextVersion) });
  });

  const coverParams = z.object({ postId: z.string().uuid() });

  /**
   * Загрузка обложки. Файл не сохраняется как есть: он пересобирается через
   * sharp в тот WebP, который ждёт вёрстка, — присланному из браузера файлу
   * доверять нельзя, даже если панель его уже обработала.
   */
  app.post(
    "/posts/:postId/cover",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = coverParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Некорректный идентификатор статьи" });
      }
      const { postId } = params.data;

      const target = await prisma.post.findFirst({
        where: { id: postId, deletedAt: null },
      });
      if (!target) return reply.code(404).send({ error: "Статья не найдена" });

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
        processed = await processCover(raw, target.slug);
      } catch (cause) {
        request.log.warn({ cause }, "не удалось обработать обложку");
        return reply
          .code(415)
          .send({ error: "Не похоже на картинку — поддерживаются PNG, JPEG и WebP" });
      }

      await prisma.post.update({
        where: { id: postId },
        data: { cover: processed.path },
      });

      const version = await bumpRevision(POSTS_SCOPE);
      await audit(request, {
        entity: "post_covers",
        entityId: postId,
        action: "upload",
        diff: { path: processed.path, bytes: processed.bytes },
      });

      return reply.send({
        cover: {
          path: processed.path,
          hash: processed.hash,
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes,
        },
        version: String(version),
      });
    },
  );

  app.get("/posts/cover-spec", { preHandler: requireAdmin }, async (_request, reply) =>
    reply.send({
      width: BLOG_COVER.width,
      height: BLOG_COVER.height,
      fit: BLOG_COVER.fit,
    }),
  );
}
