import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { isAdmin, projectScope, taskScope, type Viewer } from "../access.js";

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
 *
 * Сотрудник ищет только в своём: видимые задачи и проекты и заметки к ним. Клиенты и
 * доступы для него не существуют. Условие стоит в запросе, а не фильтром по готовому
 * списку: иначе лимит на раздел съели бы чужие записи.
 */

/** По разделу, чтобы длинный запрос не отдавал сотню строк одного вида. */
const PER_ENTITY = 5;

const query = z.object({ q: z.string().trim().min(2).max(100) });

export interface SearchHit {
  entity: "clients" | "projects" | "tasks" | "credentials";
  label: string;
  id: string;
  title: string;
  /** Вторая строка: чем эта запись отличается от соседней с тем же названием. */
  hint: string | null;
}

/**
 * Своего экрана у подзадачи нет: она открывается в карточке родителя. Поэтому находится
 * только та, чей родитель не удалён и виден: иначе выдача вела бы в никуда.
 */
function reachableTask(viewer: Viewer): Prisma.TaskWhereInput {
  return {
    OR: [{ parentId: null }, { parent: { deletedAt: null, AND: [taskScope(viewer)] } }],
  };
}

const TASK_PARENT = { select: { id: true, title: true } } as const;

/** Подзадача ведёт на родителя: `id` в выдаче — это то, что откроется. */
function taskTarget(task: { id: string; parent: { id: string; title: string } | null }): {
  id: string;
  label: string;
} {
  return task.parent
    ? { id: task.parent.id, label: "Подзадача" }
    : { id: task.id, label: "Задача" };
}

/** Какие заметки можно искать этому человеку. У заметок нет внешнего ключа, поэтому по id. */
async function noteScope(viewer: Viewer): Promise<Prisma.NoteWhereInput> {
  // Заметки лидов отсекаются: ссылка на лид из общего поиска никуда бы не вела.
  if (isAdmin(viewer)) return { entity: { not: "lead" } };

  const [tasks, projects] = await Promise.all([
    prisma.task.findMany({
      where: { deletedAt: null, AND: [taskScope(viewer), reachableTask(viewer)] },
      select: { id: true },
    }),
    prisma.project.findMany({
      where: { deletedAt: null, AND: [projectScope(viewer)] },
      select: { id: true },
    }),
  ]);
  return {
    OR: [
      { entity: "task", entityId: { in: tasks.map((item) => item.id) } },
      { entity: "project", entityId: { in: projects.map((item) => item.id) } },
    ],
  };
}

function hitKey(hit: Pick<SearchHit, "entity" | "id">): string {
  return `${hit.entity}:${hit.id}`;
}

/** Задача и её подзадача ведут в одну карточку, а она не должна стоять в выдаче дважды. */
function uniqueHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hitKey(hit))) return false;
    seen.add(hitKey(hit));
    return true;
  });
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
    const viewer = request.user!;
    const admin = isAdmin(viewer);
    // В AND: рядом стоит OR поиска, а условия видимости тоже с OR.
    const visibleTask = { AND: [taskScope(viewer), reachableTask(viewer)] };
    const visibleProject = { AND: [projectScope(viewer)] };

    const [clients, projects, tasks, credentials, notes] = await Promise.all([
      admin
        ? prisma.client.findMany({
            where: { ...alive, OR: [{ name: like }, { inn: like }, { notes: like }] },
            take,
            orderBy: { name: "asc" },
          })
        : [],
      prisma.project.findMany({
        where: {
          ...alive,
          ...visibleProject,
          OR: [{ title: like }, { description: like }],
        },
        take,
        orderBy: { updatedAt: "desc" },
        include: { client: { select: { name: true } } },
      }),
      prisma.task.findMany({
        where: { ...alive, ...visibleTask, OR: [{ title: like }, { description: like }] },
        take,
        orderBy: { updatedAt: "desc" },
        include: { project: { select: { title: true } }, parent: TASK_PARENT },
      }),
      admin
        ? prisma.credential.findMany({
            where: {
              ...alive,
              OR: [{ service: like }, { login: like }, { notes: like }],
            },
            take,
            orderBy: { service: "asc" },
            include: { project: { select: { title: true } } },
          })
        : [],
      // Заметки ищутся отдельно: они лежат одной таблицей на все сущности, и
      // найденная заметка указывает на свою запись, а не на себя.
      prisma.note.findMany({
        where: { body: like, ...(await noteScope(viewer)) },
        take: take * 2,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const hits: SearchHit[] = uniqueHits([
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
        hint: projectHint(item.archivedAt !== null, item.client?.name),
      })),
      ...tasks.map((item) => ({
        entity: "tasks" as const,
        ...taskTarget(item),
        title: item.title,
        hint: item.parent
          ? `В задаче: ${item.parent.title}`
          : (item.project?.title ?? null),
      })),
      ...credentials.map((item) => ({
        entity: "credentials" as const,
        label: "Доступ",
        id: item.id,
        title: item.service,
        hint: item.project?.title ?? item.login,
      })),
    ]);

    return reply.send({ hits, notes: await resolveNotes(notes, hits, viewer) });
  });
}

/**
 * Архивный проект в поиске находится: иначе до него не добраться по памяти. Но по
 * выдаче должно быть видно, что он убран, а не идёт сейчас.
 */
function projectHint(archived: boolean, text: string | null | undefined): string | null {
  return [archived ? "архив" : null, text].filter(Boolean).join(" · ") || null;
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
  viewer: Viewer,
): Promise<SearchHit[]> {
  const already = new Set(hits.map(hitKey));
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
    const titles = await titlesFor(entity, ids, viewer);
    for (const [id, { target, label, title, archived }] of titles) {
      found.push({
        entity: `${entity}s` as SearchHit["entity"],
        label: label ?? LABELS[entity] ?? entity,
        id: target,
        title,
        hint: projectHint(archived, bucket.get(id)?.slice(0, 120)),
      });
    }
  }

  // Заметка подзадачи ведёт на родителя, а он мог уже найтись сам.
  return uniqueHits(found).filter((hit) => !already.has(hitKey(hit)));
}

const LABELS: Record<string, string> = {
  client: "Клиент",
  project: "Проект",
  task: "Задача",
};

interface NoteTarget {
  /** Что откроется: у заметки подзадачи это родитель. */
  target: string;
  label?: string;
  title: string;
  archived: boolean;
}

/** Ключ результата — запись, к которой относится заметка. */
async function titlesFor(
  entity: string,
  ids: string[],
  viewer: Viewer,
): Promise<Map<string, NoteTarget>> {
  const titles = new Map<string, NoteTarget>();
  if (ids.length === 0) return titles;
  const where = { id: { in: ids }, deletedAt: null };

  if (entity === "client") {
    for (const row of await prisma.client.findMany({ where })) {
      titles.set(row.id, { target: row.id, title: row.name, archived: false });
    }
  } else if (entity === "project") {
    for (const row of await prisma.project.findMany({ where })) {
      titles.set(row.id, {
        target: row.id,
        title: row.title,
        archived: row.archivedAt !== null,
      });
    }
  } else if (entity === "task") {
    const rows = await prisma.task.findMany({
      where: { ...where, ...reachableTask(viewer) },
      include: { parent: TASK_PARENT },
    });
    for (const row of rows) {
      const { id, label } = taskTarget(row);
      titles.set(row.id, { target: id, label, title: row.title, archived: false });
    }
  }

  return titles;
}
