import { prisma } from "../../db.js";
import type { NoteEntity } from "../notes.js";
import { rememberUnbilledMonth } from "../projects/monthly-documents.js";

/**
 * Корзина: что удалено, но ещё может вернуться.
 *
 * Мягкое удаление раньше было кладбищем — записи копились и не читались
 * никогда, ни одним экраном. Теперь это отсрочка: тридцать дней запись можно
 * вернуть, потом она исчезает насовсем. Заодно это ответ на вопрос о
 * персональных данных: контакты удалённого лида не живут в базе вечно.
 *
 * Целостность при окончательном удалении обеспечивает сама база — все связи
 * объявляют `onDelete`, так что каскады и обнуления происходят сами.
 */

/** Сколько живёт удалённое. Месяц: ошибку замечают в первые дни, не позже. */
export const RETENTION_DAYS = 30;

export interface TrashEntry {
  id: string;
  title: string;
  deletedAt: Date;
}

export interface TrashModel {
  /** Единственное число, как подпись в списке: «Лид», «Проект». */
  label: string;
  /** К какой сущности привязаны заметки. `null` — заметок у неё не бывает. */
  notes: NoteEntity | null;
  list: () => Promise<TrashEntry[]>;
  restore: (id: string) => Promise<void>;
  /** Окончательно удалить всё, что старше даты. Возвращает число строк. */
  purge: (before: Date) => Promise<string[]>;
  purgeOne: (id: string) => Promise<void>;
}

const deleted = { deletedAt: { not: null } } as const;
const newestFirst = { deletedAt: "desc" } as const;

// `satisfies`, а не аннотация: так TypeScript помнит точный набор ключей и
// обращение по ним не превращается в «возможно undefined».
export const TRASH = {
  leads: {
    label: "Лид",
    notes: "lead",
    list: async () =>
      (
        await prisma.lead.findMany({
          where: deleted,
          select: { id: true, name: true, contact: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({
        id: row.id,
        title: row.name?.trim() || row.contact,
        deletedAt: row.deletedAt!,
      })),
    restore: async (id) => {
      await prisma.lead.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.lead.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.lead.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.lead.delete({ where: { id } });
    },
  },

  clients: {
    label: "Клиент",
    notes: "client",
    list: async () =>
      (
        await prisma.client.findMany({
          where: deleted,
          select: { id: true, name: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({ id: row.id, title: row.name, deletedAt: row.deletedAt! })),
    restore: async (id) => {
      await prisma.client.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.client.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.client.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.client.delete({ where: { id } });
    },
  },

  projects: {
    label: "Проект",
    notes: "project",
    list: async () =>
      (
        await prisma.project.findMany({
          where: deleted,
          select: { id: true, title: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({ id: row.id, title: row.title, deletedAt: row.deletedAt! })),
    restore: async (id) => {
      const project = await prisma.project.findUnique({ where: { id } });
      if (!project?.deletedAt) return;
      // Задачи уходили вместе с проектом — вместе и возвращаются. Те, что
      // удалили раньше него, остаются в корзине: их убирали отдельным решением.
      const { deletedAt } = project;
      await prisma.$transaction(async (tx) => {
        await tx.project.update({ where: { id }, data: { deletedAt: null } });
        await tx.task.updateMany({
          where: { projectId: id, deletedAt: { gte: deletedAt } },
          data: { deletedAt: null },
        });
        await rememberUnbilledMonth(tx, id);
      });
    },
    purge: async (before) => {
      const rows = await prisma.project.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      // Задачи и счета уйдут каскадом — так объявлено в схеме.
      await prisma.project.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.project.delete({ where: { id } });
    },
  },

  tasks: {
    label: "Задача",
    notes: "task",
    list: async () =>
      (
        await prisma.task.findMany({
          // Задачи удалённого проекта не показываются отдельно: они вернутся
          // вместе с ним, а список иначе тонет в них после одного удаления.
          where: { ...deleted, OR: [{ projectId: null }, { project: { deletedAt: null } }] },
          select: { id: true, title: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({ id: row.id, title: row.title, deletedAt: row.deletedAt! })),
    restore: async (id) => {
      await prisma.task.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.task.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.task.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.task.delete({ where: { id } });
    },
  },

  credentials: {
    label: "Доступ",
    notes: null,
    list: async () =>
      (
        await prisma.credential.findMany({
          where: deleted,
          select: { id: true, service: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({ id: row.id, title: row.service, deletedAt: row.deletedAt! })),
    restore: async (id) => {
      await prisma.credential.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.credential.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.credential.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.credential.delete({ where: { id } });
    },
  },

  cases: {
    label: "Кейс",
    notes: null,
    list: async () =>
      (
        await prisma.case.findMany({
          where: deleted,
          select: { id: true, title: true, slug: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({
        id: row.id,
        title: row.title || row.slug,
        deletedAt: row.deletedAt!,
      })),
    restore: async (id) => {
      await prisma.case.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.case.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.case.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.case.delete({ where: { id } });
    },
  },
  posts: {
    label: "Статья",
    notes: null,
    list: async () =>
      (
        await prisma.post.findMany({
          where: deleted,
          select: { id: true, title: true, slug: true, deletedAt: true },
          orderBy: newestFirst,
        })
      ).map((row) => ({
        id: row.id,
        title: row.title || row.slug,
        deletedAt: row.deletedAt!,
      })),
    restore: async (id) => {
      await prisma.post.update({ where: { id }, data: { deletedAt: null } });
    },
    purge: async (before) => {
      const rows = await prisma.post.findMany({
        where: { deletedAt: { lt: before } },
        select: { id: true },
      });
      await prisma.post.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows.map((r) => r.id);
    },
    purgeOne: async (id) => {
      await prisma.post.delete({ where: { id } });
    },
  },
} satisfies Record<string, TrashModel>;

export type TrashEntity = keyof typeof TRASH;

export const TRASH_ENTITIES = Object.keys(TRASH) as [TrashEntity, ...TrashEntity[]];
