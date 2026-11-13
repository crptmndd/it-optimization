import type { Prisma, Task } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "../../db.js";
import { isAdmin, liveTask, projectScope, taskScope, type Viewer } from "../access.js";
import { normalizeTaskStatus, placeCard } from "../columns/columns.js";
import { createNote } from "../notes.js";
import { assertDevelopers } from "../people.js";
import {
  CLOSED_TASK_STATUSES,
  TASK_RELATIONS,
  type createTaskBody,
  type updateTaskBody,
} from "./dto.js";

/**
 * Постановка задачи — одна, кто бы её ни ставил: форма CRM через `POST /tasks` или бот из
 * сообщения в телеграме. Проверки видимости, место на доске и правило «у подзадачи нет
 * заметок» живут здесь, иначе бот стал бы обходным путём мимо них. Журнал и уведомления
 * остаются у вызывающего: у маршрута есть запрос, у бота его нет, и пишет он с задержкой.
 */

export type TaskStatusValue = Prisma.EnumTaskStatusFilter["equals"] & string;

export type CreateTaskInput = z.infer<typeof createTaskBody>;

export function isClosed(status: string): boolean {
  return (CLOSED_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Дата выполнения ставится и снимается автоматически. Руками её никто не
 * проставит, а без неё нельзя ответить на вопрос «сколько задач закрыли за
 * неделю» — и «выполнено» перестаёт отличаться от «висит с прошлого года».
 */
export function completedAtFor(
  status: string | undefined,
  current: Date | null,
): Date | null | undefined {
  if (status === undefined) return undefined;
  if (isClosed(status)) return current ?? new Date();
  return null;
}

/** Чужой проект для сотрудника не существует, поэтому и ответ тот же, что на пустой id. */
export async function assertReferences(
  viewer: Viewer,
  input: { projectId?: string | null; developers?: string[] },
): Promise<string | null> {
  if (input.projectId) {
    const found = await prisma.project.count({
      where: { id: input.projectId, deletedAt: null, AND: [projectScope(viewer)] },
    });
    if (!found) return "Проект не найден";
  }
  return assertDevelopers(input.developers);
}

/**
 * Новая задача встаёт в конец своей колонки. На доске только верхний уровень. У двух
 * колонок одного типа номера свои; задача без колонки (отменённая, подзадача) считается
 * по статусу, как раньше.
 */
export async function nextPosition(slot: {
  columnId: string | null;
  status: string;
}): Promise<number> {
  const last = await prisma.task.aggregate({
    where: {
      ...(slot.columnId
        ? { columnId: slot.columnId }
        : { status: slot.status as TaskStatusValue }),
      deletedAt: null,
      parentId: null,
    },
    _max: { position: true },
  });
  return (last._max.position ?? -1) + 1;
}

/** Запись, с которой человек может работать. Чужая отвечает тем же 404, что и пустой id. */
export function reachableTask(id: string, viewer: Viewer): Prisma.TaskWhereInput {
  return { id, AND: [liveTask, taskScope(viewer)] };
}

/**
 * Родитель новой подзадачи. Строка держится до конца транзакции: иначе смена проекта у
 * родителя проскочила бы между чтением и вставкой, и подзадача осталась бы в старом
 * проекте. Блокировка разделяемая: две подзадачи одной задачи друг другу не мешают.
 */
async function readParent(tx: Prisma.TransactionClient, id: string, viewer: Viewer) {
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${id}::uuid FOR SHARE`;
  return tx.task.findFirst({
    where: reachableTask(id, viewer),
    select: { parentId: true, projectId: true },
  });
}

export type CreatedTask = Prisma.TaskGetPayload<{ include: typeof TASK_RELATIONS }>;

export type CreateTaskResult =
  { ok: true; task: CreatedTask } | { ok: false; code: 400 | 404; error: string };

export async function createTask(
  viewer: Viewer,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const parentId = input.parentId ?? null;

  // Своего окна у подзадачи нет, и заметку к ней никто бы не увидел. Отказ честнее:
  // текст остаётся у того, кто его написал, а не пропадает в невидимой записи.
  if (parentId && input.note) {
    return { ok: false, code: 400, error: "У подзадачи не бывает заметок" };
  }

  // Проект подзадачи всегда родительский, присланный ни на что не влияет.
  const problem = await assertReferences(
    viewer,
    parentId ? { developers: input.developers } : input,
  );
  if (problem) return { ok: false, code: 400, error: problem };

  // Колонка сильнее статуса. У подзадачи колонки нет: на доске её не бывает.
  const requested = normalizeTaskStatus(input.status) ?? "todo";
  const placed = parentId
    ? ({ ok: true, columnId: null, status: requested } as const)
    : await placeCard(prisma, "task", {
        columnId: input.columnId ?? undefined,
        status: input.columnId ? undefined : requested,
      });
  if (!placed.ok) return { ok: false, code: 400, error: placed.error };
  const status = placed.status as TaskStatusValue;
  const position = await nextPosition(placed);

  return prisma.$transaction(async (tx): Promise<CreateTaskResult> => {
    let projectId = input.projectId ?? null;

    if (parentId) {
      const parent = await readParent(tx, parentId, viewer);
      if (!parent) return { ok: false, code: 404, error: "Задача не найдена" };
      if (parent.parentId) {
        return { ok: false, code: 400, error: "У подзадачи не бывает своих подзадач" };
      }
      projectId = parent.projectId;
    }

    const task = await tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        status,
        columnId: placed.columnId,
        priority: input.priority ?? "normal",
        projectId,
        parentId,
        developers: input.developers ?? [],
        createdById: viewer.id,
        dueAt: input.dueAt ?? null,
        completedAt: completedAtFor(status, null) ?? null,
        position,
      },
      include: TASK_RELATIONS,
    });
    if (input.note) await createNote("task", task.id, viewer.id, input.note, tx);
    return { ok: true, task };
  });
}

export type UpdateTaskInput = z.infer<typeof updateTaskBody>;

export type UpdateTaskResult =
  | { ok: true; task: CreatedTask; existing: Task }
  | { ok: false; code: 400 | 404; error: string };

/**
 * Правка задачи — та же, что у `PATCH /tasks/:id`: её зовут и форма CRM, и кнопки с
 * ответами в телеграме. Журнал и уведомления остаются вызывающему, как и у `createTask`.
 */
export async function updateTask(
  viewer: Viewer,
  id: string,
  input: UpdateTaskInput,
): Promise<UpdateTaskResult> {
  const existing = await prisma.task.findFirst({
    where: reachableTask(id, viewer),
  });
  if (!existing) return { ok: false, code: 404, error: "Задача не найдена" };

  const movesSubtask =
    existing.parentId !== null &&
    input.projectId !== undefined &&
    input.projectId !== existing.projectId;
  if (movesSubtask) {
    return { ok: false, code: 400, error: "Подзадача живёт в проекте своей задачи" };
  }

  const problem = await assertReferences(viewer, input);
  if (problem) return { ok: false, code: 400, error: problem };

  const data: Prisma.TaskUncheckedUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.projectId !== undefined) data.projectId = input.projectId;
  if (input.developers !== undefined) data.developers = input.developers;
  if (input.dueAt !== undefined) data.dueAt = input.dueAt;

  // Смена колонки или статуса — переезд, поэтому задача встаёт в конец новой колонки.
  // Иначе она приземлилась бы в середину по старому номеру позиции. Колонка сильнее
  // статуса; один статус от старой формы оставляет задачу в её колонке, если та того
  // же типа, иначе ставит в первую колонку типа.
  let nextStatus: string | undefined;
  if (input.columnId !== undefined || input.status !== undefined) {
    const requested = normalizeTaskStatus(input.status);
    const placed = existing.parentId
      ? ({ ok: true, columnId: null, status: requested ?? existing.status } as const)
      : await placeCard(
          prisma,
          "task",
          { columnId: input.columnId ?? undefined, status: requested },
          existing,
        );
    if (!placed.ok) return { ok: false, code: 400, error: placed.error };
    nextStatus = placed.status;
    if (placed.status !== existing.status || placed.columnId !== existing.columnId) {
      data.status = placed.status as TaskStatusValue;
      data.columnId = placed.columnId;
      data.position = await nextPosition(placed);
      // Задачу двинули — ею снова занимаются, ручной архив снимается.
      data.archivedAt = null;
    }
  }

  const completedAt = completedAtFor(nextStatus, existing.completedAt);
  if (completedAt !== undefined) data.completedAt = completedAt;

  const task = await prisma.$transaction(async (tx) => {
    const updated = await tx.task.update({
      where: { id: existing.id },
      data,
      include: TASK_RELATIONS,
    });

    // Вместе с лежащими в Корзине: вернувшись, подзадача не должна оказаться в чужом
    // проекте. Без сравнения с прочитанным выше: оно могло устареть, а здесь строка
    // родителя уже заблокирована, и подзадачи получают то, что записано в ней.
    if (input.projectId !== undefined) {
      await tx.task.updateMany({
        where: { parentId: existing.id },
        data: { projectId: input.projectId },
      });
    }
    return updated;
  });
  return { ok: true, task, existing };
}

export type ArchiveTaskResult =
  { ok: true; task: CreatedTask } | { ok: false; code: 400 | 403 | 404; error: string };

/**
 * Ручной архив — тот же, что «В архив» в CRM и «☑️ Проверено» в телеграме. Только админ:
 * архив убирает задачу с доски, из «Сегодня» и сводки. Подзадача уходит и возвращается
 * только со своей задачей. Возврат снимает лишь ручную отметку.
 */
export async function setTaskArchived(
  viewer: Viewer,
  id: string,
  archived: boolean,
): Promise<ArchiveTaskResult> {
  if (!isAdmin(viewer)) {
    return { ok: false, code: 403, error: "Убрать задачу в архив может админ" };
  }
  const existing = await prisma.task.findFirst({ where: reachableTask(id, viewer) });
  if (!existing) return { ok: false, code: 404, error: "Задача не найдена" };
  if (existing.parentId) {
    return {
      ok: false,
      code: 400,
      error: "Подзадача уходит в архив вместе со своей задачей",
    };
  }
  const task = await prisma.task.update({
    where: { id: existing.id },
    data: { archivedAt: archived ? (existing.archivedAt ?? new Date()) : null },
    include: TASK_RELATIONS,
  });
  return { ok: true, task };
}
