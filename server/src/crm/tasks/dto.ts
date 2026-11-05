import type { Prisma, Project, Task } from "@prisma/client";
import { z } from "zod";
import { optionalDate, optionalText, optionalUuid, requiredTitle } from "../fields.js";
import { NOTE_MAX_LENGTH } from "../notes.js";
import { MAX_DEVELOPERS } from "../people.js";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;
/** От низкой к срочной, как в enum базы. `high` значит «Срочно», см. `schema.prisma`. */
export const TASK_PRIORITIES = ["low", "normal", "important", "high"] as const;

/** Незакрытые: только они попадают в напоминания и в счётчики проекта. */
export const OPEN_TASK_STATUSES = ["backlog", "todo", "in_progress"] as const;
export const CLOSED_TASK_STATUSES = ["done", "cancelled"] as const;

/**
 * Архив задач. Два пути туда. Закрытая задача (готово или отменена) уходит сама через три
 * дня после закрытия: это вычисляется, без планировщика, и возврат в работу стирает дату
 * закрытия, поэтому задача сразу снова на доске. Старые закрытые без даты закрытия
 * считаются по последней правке. А админ может убрать любую задачу руками, открытую тоже:
 * это `archivedAt`, и такая задача пропадает и из «Сегодня», и из сводки.
 */
export const ARCHIVE_AFTER_DAYS = 3;

export function archiveCutoff(now = new Date()): Date {
  return new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

export function archivedTaskWhere(cutoff: Date): Prisma.TaskWhereInput {
  return {
    OR: [
      { archivedAt: { not: null } },
      {
        status: { in: [...CLOSED_TASK_STATUSES] },
        OR: [
          { completedAt: { lt: cutoff } },
          { completedAt: null, updatedAt: { lt: cutoff } },
        ],
      },
    ],
  };
}

function isArchived(
  item: {
    status: string;
    completedAt: Date | null;
    updatedAt: Date;
    archivedAt: Date | null;
  },
  cutoff: Date,
): boolean {
  if (item.archivedAt) return true;
  if (!(CLOSED_TASK_STATUSES as readonly string[]).includes(item.status)) return false;
  return (item.completedAt ?? item.updatedAt) < cutoff;
}

const taskFields = {
  title: requiredTitle(300, "Без названия задача бесполезна"),
  description: optionalText(4000),
  status: z.enum(TASK_STATUSES),
  /** Колонка доски. Сильнее статуса: статус берётся из её типа. */
  columnId: optionalUuid,
  priority: z.enum(TASK_PRIORITIES),
  projectId: optionalUuid,
  developers: z.array(z.string().trim().min(1).max(120)).max(MAX_DEVELOPERS),
  dueAt: optionalDate,
  /**
   * Писать ли о постановке в общий чат. Не хранится: относится к одному сохранению,
   * которое ставит задачу или добавляет людей. Нет поля — пишет, как раньше.
   */
  notifyChat: z.boolean(),
};

/**
 * `parentId` есть только при создании: перенос подзадачи к другому родителю никто не
 * просил, а вложенность в один уровень держится на том, что верхняя задача не становится
 * подзадачей и наоборот.
 *
 * `note` тоже только при создании и не в `taskFields`, поэтому в `PATCH` его нет: у
 * заведённой задачи заметки идут своим маршрутом. Пустая значит, что заметки нет.
 */
export const createTaskBody = z
  .object({ ...taskFields, parentId: optionalUuid, note: optionalText(NOTE_MAX_LENGTH) })
  .partial()
  .required({ title: true });

export const updateTaskBody = z.object(taskFields).partial();

/**
 * Перестановка задач приходит одним списком идентификаторов в нужном порядке.
 * Слать по одной позиции нельзя: перетаскивание меняет положение сразу
 * нескольких задач, и частично применённый порядок выглядит как потеря данных.
 */
export const reorderTasksBody = z
  .object({
    /** Новая CRM присылает колонку: в двух колонках одного типа номера свои. */
    columnId: z.string().uuid().optional(),
    /** Старая вкладка во время выката присылает статус. */
    status: z.enum(TASK_STATUSES).optional(),
    ids: z.array(z.string().uuid()).max(500),
  })
  .refine((body) => body.columnId || body.status, { message: "Нужна колонка" });

export const listTasksQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  scope: z.enum(["open", "closed", "all"]).default("all"),
  projectId: z.string().uuid().optional(),
  developer: z.string().trim().min(1).max(120).optional(),
  /** Задачи без проекта — их легко потерять, поэтому нужен отдельный срез. */
  standalone: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  overdue: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  search: z.string().trim().max(200).optional(),
  /**
   * `exclude` — без архива (доска и списки), `only` — только архив, `include` — всё.
   * По умолчанию всё: старая вкладка во время выката архива не знает.
   */
  archived: z.enum(["exclude", "only", "include"]).default("include"),
});

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  status: (typeof TASK_STATUSES)[number];
  /** Колонка доски. Пусто у подзадачи и у отменённой: на доске их нет. */
  columnId: string | null;
  /** В архиве — сама (закрыта больше трёх дней назад) или руками: на доске её нет. */
  archived: boolean;
  /** Когда убрали руками. Пусто — задача в архиве сама по возрасту или не в архиве. */
  archivedAt: string | null;
  priority: (typeof TASK_PRIORITIES)[number];
  project: { id: string; title: string } | null;
  /** Заполнен у подзадачи: своего экрана у неё нет, открывается родитель. */
  parentId: string | null;
  /** Прогресс «2 из 5» для карточки и строки списка. Удалённые не считаются. */
  subtasks: { total: number; done: number };
  developers: string[];
  dueAt: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubtaskDto {
  id: string;
  title: string;
  status: (typeof TASK_STATUSES)[number];
  developers: string[];
  completedAt: string | null;
}

export interface TaskDetailDto extends TaskDto {
  subtaskList: SubtaskDto[];
}

type TaskWithRelations = Task & {
  project: Pick<Project, "id" | "title"> | null;
  subtasks: Pick<Task, "status">[];
};

type TaskWithSubtasks = Omit<TaskWithRelations, "subtasks"> & {
  subtasks: Pick<Task, "id" | "title" | "status" | "developers" | "completedAt">[];
};

export function toTaskDto(item: TaskWithRelations): TaskDto {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    columnId: item.columnId,
    archived: isArchived(item, archiveCutoff()),
    archivedAt: item.archivedAt?.toISOString() ?? null,
    priority: item.priority,
    project: item.project ? { id: item.project.id, title: item.project.title } : null,
    parentId: item.parentId,
    subtasks: {
      total: item.subtasks.length,
      done: item.subtasks.filter((subtask) => subtask.status === "done").length,
    },
    developers: item.developers,
    dueAt: item.dueAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
    position: item.position,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function toTaskDetailDto(item: TaskWithSubtasks): TaskDetailDto {
  return {
    ...toTaskDto(item),
    subtaskList: item.subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
      developers: subtask.developers,
      completedAt: subtask.completedAt?.toISOString() ?? null,
    })),
  };
}

export const TASK_RELATIONS = {
  project: { select: { id: true, title: true } },
  /** Нужен сообщениям бота: подзадача называет родителя и ведёт на него. */
  parent: { select: { id: true, title: true } },
  subtasks: { where: { deletedAt: null }, select: { status: true } },
} as const;

/** Второй ключ: при равном времени порядок строк менялся бы от запроса к запросу. */
const SUBTASK_ORDER: Prisma.TaskOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/** Карточка задачи: те же связи, но подзадачи целиком и в порядке появления. */
export const TASK_DETAIL_RELATIONS = {
  ...TASK_RELATIONS,
  subtasks: {
    where: { deletedAt: null },
    orderBy: SUBTASK_ORDER,
    select: { id: true, title: true, status: true, developers: true, completedAt: true },
  },
} as const;
