import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin } from "../auth/guard.js";
import { SERVICES_SCOPE, currentRevision, prisma } from "../db.js";
import { canPublish } from "../env.js";
import { commitSnapshot } from "../publish/github.js";

/**
 * Каталог услуг: разделы и принадлежность услуг разделам.
 *
 * Тексты страниц услуг здесь не живут — они в `content/services.json` и
 * правятся в репозитории. Панель управляет только структурой: какие есть
 * разделы, в каком они порядке, в каком разделе стоит услуга и опубликована ли
 * она. Этого достаточно, чтобы перекроить каталог на сайте, не трогая код.
 *
 * Снапшот уезжает в `content/service-catalog.json` — тот самый маленький файл,
 * из которого сайт выводит `SERVICE_PAGES`, `SERVICE_NAV` и кнопки фильтра.
 */

const CATALOG_PATH = "content/service-catalog.json";

const KEY = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Ключ — латиница и цифры, начиная с буквы");

const categorySchema = z.object({
  key: KEY,
  title: z.string().min(1).max(80),
});

const entrySchema = z.object({
  key: KEY,
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "Адрес — строчная латиница, цифры и дефис"),
  category: KEY,
  draft: z.boolean(),
});

const replaceBody = z.object({
  categories: z.array(categorySchema).min(1),
  services: z.array(entrySchema).min(1),
  version: z.string(),
});

interface Catalog {
  categories: { key: string; title: string }[];
  services: { key: string; slug: string; category: string; draft: boolean }[];
}

/** Каталог в порядке показа — ровно та форма, которую читает сайт. */
async function readCatalog(): Promise<Catalog> {
  const [categories, services] = await Promise.all([
    prisma.serviceCategory.findMany({ orderBy: { position: "asc" } }),
    prisma.serviceEntry.findMany({ orderBy: { position: "asc" } }),
  ]);

  return {
    categories: categories.map(({ key, title }) => ({ key, title })),
    services: services.map(({ key, slug, categoryKey, draft }) => ({
      key,
      slug,
      category: categoryKey,
      draft,
    })),
  };
}

/**
 * Проверки, которые нельзя доверить схеме: они про связи между списками.
 * Возвращаем все проблемы разом — чинить по одной за запрос мучительно.
 */
function validate(body: z.infer<typeof replaceBody>): string[] {
  const problems: string[] = [];

  const categoryKeys = new Set<string>();
  for (const category of body.categories) {
    if (categoryKeys.has(category.key)) {
      problems.push(`Раздел «${category.key}» повторяется`);
    }
    categoryKeys.add(category.key);
  }

  const serviceKeys = new Set<string>();
  const slugs = new Set<string>();
  for (const service of body.services) {
    if (serviceKeys.has(service.key)) {
      problems.push(`Услуга «${service.key}» повторяется`);
    }
    serviceKeys.add(service.key);

    if (slugs.has(service.slug)) {
      problems.push(`Адрес «${service.slug}» повторяется`);
    }
    slugs.add(service.slug);

    if (!categoryKeys.has(service.category)) {
      problems.push(
        `У услуги «${service.key}» раздел «${service.category}», которого нет`,
      );
    }
  }

  return problems;
}

export async function serviceCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/service-catalog", { preHandler: requireAdmin }, async (_request, reply) => {
    const [catalog, version] = await Promise.all([
      readCatalog(),
      currentRevision(SERVICES_SCOPE),
    ]);
    return reply.send({ ...catalog, version: String(version) });
  });

  app.put("/service-catalog", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = replaceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Некорректные данные",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const problems = validate(parsed.data);
    if (problems.length) {
      return reply.code(400).send({ error: problems[0], problems });
    }

    const { categories, services, version } = parsed.data;

    const actual = await currentRevision(SERVICES_SCOPE);
    if (String(actual) !== version) {
      return reply.code(409).send({
        error:
          "Каталог успели изменить в другом окне или на другом устройстве. Обнови страницу и внеси правки заново.",
        version: String(actual),
      });
    }

    const before = await readCatalog();

    const nextVersion = await prisma.$transaction(async (tx) => {
      // Порядок операций важен: сначала разделы, иначе услуга сошлётся на
      // раздел, которого ещё нет; удаление разделов — в самом конце, когда на
      // них уже никто не ссылается.
      for (const [index, category] of categories.entries()) {
        await tx.serviceCategory.upsert({
          where: { key: category.key },
          create: { key: category.key, title: category.title, position: index },
          update: { title: category.title, position: index },
        });
      }

      for (const [index, service] of services.entries()) {
        await tx.serviceEntry.upsert({
          where: { key: service.key },
          create: {
            key: service.key,
            slug: service.slug,
            categoryKey: service.category,
            draft: service.draft,
            position: index,
          },
          update: {
            slug: service.slug,
            categoryKey: service.category,
            draft: service.draft,
            position: index,
          },
        });
      }

      await tx.serviceEntry.deleteMany({
        where: { key: { notIn: services.map((service) => service.key) } },
      });
      await tx.serviceCategory.deleteMany({
        where: { key: { notIn: categories.map((category) => category.key) } },
      });

      const row = await tx.contentRevision.upsert({
        where: { scope: SERVICES_SCOPE },
        update: { value: { increment: 1 } },
        create: { scope: SERVICES_SCOPE, value: 1 },
      });
      return row.value;
    });

    const after = await readCatalog();
    await audit(request, {
      entity: "services",
      action: "replace",
      diff: {
        before: before.categories.map((category) => category.key),
        after: after.categories.map((category) => category.key),
      },
    });

    return reply.send({ ...after, version: String(nextVersion) });
  });

  /** То, что уедет в репозиторий. Полезно для отладки публикации. */
  app.get(
    "/service-catalog/snapshot",
    { preHandler: requireAdmin },
    async (_request, reply) => reply.send(await readCatalog()),
  );

  app.post(
    "/service-catalog/publish",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const snapshot = await readCatalog();

      if (!canPublish) {
        return reply.send({
          published: false,
          reason:
            "GITHUB_TOKEN не задан — снапшот собран, но никуда не отправлен (режим разработки).",
          categories: snapshot.categories.length,
          services: snapshot.services.length,
        });
      }

      try {
        const result = await commitSnapshot(
          `content(services): каталог из админки (${snapshot.categories.length} разделов, ${snapshot.services.length} услуг)`,
          [
            {
              path: CATALOG_PATH,
              text: `${JSON.stringify(snapshot, null, 2)}\n`,
            },
          ],
        );

        await audit(request, {
          entity: "services",
          action: "publish",
          diff: { commit: result.sha, services: snapshot.services.length },
        });

        return reply.send({
          published: true,
          commitUrl: result.commitUrl,
          buildUrl: result.buildUrl,
          services: snapshot.services.length,
        });
      } catch (cause) {
        request.log.error({ cause }, "публикация каталога услуг не удалась");
        return reply.code(502).send({
          error:
            cause instanceof Error
              ? `Не удалось отправить в репозиторий: ${cause.message}`
              : "Не удалось отправить в репозиторий",
        });
      }
    },
  );
}
