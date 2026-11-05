import type { Note, Prisma, User } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { requireTeam } from "../auth/guard.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { prisma } from "../db.js";
import { isAdmin, type Viewer } from "./access.js";
import { invalidInput } from "./http.js";

/**
 * Заметки общие для всех сущностей CRM: одна таблица вместо четырёх почти
 * одинаковых. Внешнего ключа на владельца нет — он не бывает полиморфным, —
 * поэтому целостность держится здесь: писать и читать заметки можно только
 * через эти функции, и вызываются они после проверки, что запись существует.
 */
export const NOTE_ENTITIES = ["lead", "client", "project", "task"] as const;
export type NoteEntity = (typeof NOTE_ENTITIES)[number];

export interface NoteDto {
  id: string;
  body: string;
  author: { id: string; name: string | null; email: string } | null;
  createdAt: string;
}

type NoteWithAuthor = Note & { author: Pick<User, "id" | "name" | "email"> | null };

const AUTHOR_SELECT = { select: { id: true, name: true, email: true } } as const;

/**
 * Почта автора только админу: сотруднику список почт закрыт и в `GET /team`, и заметки не
 * должны быть обходным путём к нему. Пустая строка, а не отсутствие поля: тип один, а
 * автор без имени покажется экраном как «Кто-то».
 */
function toNoteDto(note: NoteWithAuthor, showEmail: boolean): NoteDto {
  return {
    id: note.id,
    body: note.body,
    author: note.author
      ? {
          id: note.author.id,
          name: note.author.name,
          email: showEmail ? note.author.email : "",
        }
      : null,
    createdAt: note.createdAt.toISOString(),
  };
}

/**
 * Последняя заметка и их число для списка записей.
 *
 * Одним запросом на весь список, а не по запросу на карточку: список из
 * тридцати записей иначе превращается в тридцать походов в базу. Заметок у
 * одной сущности единицы, поэтому выбрать все и разложить в памяти дешевле,
 * чем городить оконную функцию в обход Prisma.
 */
export interface NoteBrief {
  /** Текст последней заметки — на карточке он и показывается. */
  body: string;
  author: string | null;
  createdAt: string;
  /** Сколько всего: «ещё 3» подсказывает, что за строкой есть продолжение. */
  count: number;
}

export async function briefNotes(
  entity: NoteEntity,
  ids: string[],
  viewer: Pick<Viewer, "role">,
): Promise<Map<string, NoteBrief>> {
  const brief = new Map<string, NoteBrief>();
  if (ids.length === 0) return brief;

  const notes = await prisma.note.findMany({
    where: { entity, entityId: { in: ids } },
    orderBy: { createdAt: "desc" },
    include: { author: AUTHOR_SELECT },
  });

  for (const note of notes) {
    const seen = brief.get(note.entityId);
    if (seen) {
      seen.count += 1;
      continue;
    }
    brief.set(note.entityId, {
      body: note.body,
      author:
        note.author?.name?.trim() ||
        (isAdmin(viewer) ? note.author?.email : null) ||
        null,
      createdAt: note.createdAt.toISOString(),
      count: 1,
    });
  }

  return brief;
}

/** Хронология сверху вниз: свежая запись последняя, как в переписке. */
export async function listNotes(
  entity: NoteEntity,
  entityId: string,
  viewer: Pick<Viewer, "role">,
): Promise<NoteDto[]> {
  const notes = await prisma.note.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: "asc" },
    include: { author: AUTHOR_SELECT },
  });
  return notes.map((note) => toNoteDto(note, isAdmin(viewer)));
}

/**
 * `db` — транзакция, когда заметка заводится вместе с самой записью: задача без заметки,
 * которую человек видел в форме, была бы той же потерей текста, только молчаливой.
 */
export async function createNote(
  entity: NoteEntity,
  entityId: string,
  authorId: string,
  body: string,
  db: Prisma.TransactionClient = prisma,
): Promise<NoteDto> {
  const note = await db.note.create({
    data: { entity, entityId, authorId, body },
    include: { author: AUTHOR_SELECT },
  });
  // Автор только что написанной заметки — сам вызывающий, почта здесь его собственная.
  return toNoteDto(note, true);
}

/** Заметки уходят вместе с записью: висеть в базе без владельца им незачем. */
export async function deleteNotes(entity: NoteEntity, entityId: string): Promise<void> {
  await prisma.note.deleteMany({ where: { entity, entityId } });
}

/** Один предел и у отдельной заметки, и у той, что приходит вместе с новой задачей. */
export const NOTE_MAX_LENGTH = 4000;

export const createNoteBody = z.object({
  body: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
});

/**
 * Маршрут добавления заметки одинаков у всех сущностей — отличается двумя
 * вещами. Первая: проверка, что запись существует и видна этому человеку; без
 * внешнего ключа (см. выше) только она не даёт завести заметку в пустоту, а чужая
 * запись отвечает тем же 404, чтобы не подтверждать, что она есть. Вторая: кому
 * можно.
 *
 * Права передаются снаружи и обязательны: заметки клиентов только у админа, а к
 * проекту или задаче пишет и сотрудник. Значение по умолчанию стало бы дырой, через
 * которую он комментирует чужие разделы.
 */
export async function noteRoutesFor(
  app: FastifyInstance,
  entity: NoteEntity,
  basePath: string,
  exists: (id: string, viewer: AuthenticatedUser) => Promise<boolean>,
  notFound: string,
  guard: typeof requireTeam,
): Promise<void> {
  const params = z.object({ id: z.string().uuid() });

  app.post(`/${basePath}/:id/notes`, { preHandler: guard }, async (request, reply) => {
    const parsedParams = params.safeParse(request.params);
    if (!parsedParams.success) return invalidInput(reply, parsedParams.error);

    const parsed = createNoteBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    if (!(await exists(parsedParams.data.id, request.user!))) {
      return reply.code(404).send({ error: notFound });
    }

    const note = await createNote(
      entity,
      parsedParams.data.id,
      request.user!.id,
      parsed.data.body,
    );
    return reply.code(201).send({ note });
  });
}
