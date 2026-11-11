import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "../../db.js";
import { liveTask, projectScope, taskScope, type Viewer } from "../access.js";
import { normalizeTaskStatus, placeCard } from "../columns/columns.js";
import { createNote } from "../notes.js";
import { assertDevelopers } from "../people.js";
import { CLOSED_TASK_STATUSES, TASK_RELATIONS, type createTaskBody } from "./dto.js";

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
