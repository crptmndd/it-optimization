import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { invalidInput } from "../http.js";

/**
 * Поиск по всей CRM одним запросом.
 *
 * До него, чтобы найти «Парки Казани», надо было помнить, в каком разделе они
 * лежат, и открыть его руками. На трёх десятках записей это терпимо, на трёх
 * сотнях — нет.
 *
 * Ищется по названиям, контактам и заметкам — по тому, что человек помнит.
 * Поиск нечувствителен к регистру, но подстрокой, а не по словам: полнотекстовый
 * индекс Postgres умеет больше, но требует морфологии, а «Казан» без неё не
 * найдёт «Казани». Подстрока такие случаи закрывает сама.
 */

/** По разделу, чтобы длинный запрос не отдавал сотню строк одного вида. */
const PER_ENTITY = 5;

const query = z.object({ q: z.string().trim().min(2).max(100) });

export interface SearchHit {
  entity: "leads" | "clients" | "projects" | "tasks" | "credentials";
  label: string;
  id: string;
  title: string;
  /** Вторая строка: чем эта запись отличается от соседней с тем же названием. */
  hint: string | null;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search", { preHandler: requireTeam }, async (request, reply) => {
    const parsed = query.safeParse(request.query);
    // Короткий запрос — не ошибка, а «ещё не дописали»: отдаём пустоту молча.
    if (!parsed.success) return reply.send({ hits: [] });

    const q = parsed.data.q;
    const like = { contains: q, mode: "insensitive" as const };
    const alive = { deletedAt: null };
    const take = PER_ENTITY;

    const [leads, clients, projects, tasks, credentials, notes] = await Promise.all([
      prisma.lead.findMany({
        where: {
          ...alive,
          OR: [{ name: like },
            { contact: like },
            { message: like },
            { nextActionNote: like },],
        },
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.client.findMany({
        where: { ...alive, OR: [{ name: like }, { inn: like }, { notes: like }] },
        take,
        orderBy: { name: "asc" },
      }),
      prisma.project.findMany({
        where: { ...alive, OR: [{ title: like }, { description: like }] },
        take,
        orderBy: { updatedAt: "desc" },
        include: { client: { select: { name: true } } },
      }),
      prisma.task.findMany({
        where: { ...alive, OR: [{ title: like }, { description: like }] },
        take,
        orderBy: { updatedAt: "desc" },
        include: { project: { select: { title: true } } },
      }),
      prisma.credential.findMany({
        where: { ...alive, OR: [{ service: like }, { login: like }, { notes: like }] },
        take,
        orderBy: { service: "asc" },
        include: { project: { select: { title: true } } },
      }),
      // Заметки ищутся отдельно: они лежат одной таблицей на все сущности, и
      // найденная заметка указывает на свою запись, а не на себя.
      prisma.note.findMany({
        where: { body: like },
        take: take * 2,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const hits: SearchHit[] = [
      ...leads.map((item) => ({
        entity: "leads" as const,
        label: "Лид",
        id: item.id,
        title: item.name?.trim() || item.contact,
        hint: item.name?.trim() ? item.contact : null,
      })),
      ...clients.map((item) => ({
        entity: "clients" as const,
        label: "Клиент",
        id: item.id,
        title: item.name,
        hint: item.inn ? `ИНН ${item.inn}` : null,
      })),
      ...projects.map((item) => ({
        entity: "projects" as const,
        label: "Проект",
        id: item.id,
        title: item.title,
        hint: item.client?.name ?? null,
      })),
      ...tasks.map((item) => ({
        entity: "tasks" as const,
        label: "Задача",
        id: item.id,
        title: item.title,
        hint: item.project?.title ?? null,
      })),
      ...credentials.map((item) => ({
        entity: "credentials" as const,
        label: "Доступ",
        id: item.id,
        title: item.service,
        hint: item.project?.title ?? item.login,
      })),
    ];

    return reply.send({ hits, notes: await resolveNotes(notes, hits) });
  });
}

/**
 * Заметки превращаются в ссылки на свои записи.
 *
 * Уже найденные напрямую пропускаются: одна и та же карточка дважды в выдаче
 * выглядит как ошибка, даже когда совпало и название, и заметка.
 */
async function resolveNotes(
  notes: { entity: string; entityId: string; body: string }[],
  hits: SearchHit[],
): Promise<SearchHit[]> {
  const already = new Set(hits.map((hit) => `${hit.entity}:${hit.id}`));
  const byEntity = new Map<string, Map<string, string>>();

  for (const note of notes) {
    const plural = `${note.entity}s`;
    if (already.has(`${plural}:${note.entityId}`)) continue;
    const bucket = byEntity.get(note.entity) ?? new Map();
    if (!bucket.has(note.entityId)) bucket.set(note.entityId, note.body);
    byEntity.set(note.entity, bucket);
  }

  const found: SearchHit[] = [];

  for (const [entity, bucket] of byEntity) {
    const ids = [...bucket.keys()];
    const titles = await titlesFor(entity, ids);
    for (const [id, title] of titles) {
      found.push({
        entity: `${entity}s` as SearchHit["entity"],
        label: LABELS[entity] ?? entity,
        id,
        title,
        hint: bucket.get(id)?.slice(0, 120) ?? null,
      });
    }
  }

  return found;
}

const LABELS: Record<string, string> = {
  lead: "Лид",
  client: "Клиент",
  project: "Проект",
  task: "Задача",
};

async function titlesFor(entity: string, ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const where = { id: { in: ids }, deletedAt: null };

  if (entity === "lead") {
    for (const row of await prisma.lead.findMany({ where })) {
      titles.set(row.id, row.name?.trim() || row.contact);
    }
  } else if (entity === "client") {
    for (const row of await prisma.client.findMany({ where })) titles.set(row.id, row.name);
  } else if (entity === "project") {
    for (const row of await prisma.project.findMany({ where })) titles.set(row.id, row.title);
  } else if (entity === "task") {
    for (const row of await prisma.task.findMany({ where })) titles.set(row.id, row.title);
  }

  return titles;
}
