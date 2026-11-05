import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { notifyTaskInBackground } from "../../notify/notifications.js";
import { liveTask, projectScope, taskScope, type Viewer } from "../access.js";
import { invalidInput } from "../http.js";
import { briefNotes, listNotes, noteRoutesFor } from "../notes.js";
import { normalizeTaskStatus, placeCard } from "../columns/columns.js";
import { assertDevelopers } from "../people.js";
import {
  archiveCutoff,
  archivedTaskWhere,
  CLOSED_TASK_STATUSES,
  createTaskBody,
  listTasksQuery,
  OPEN_TASK_STATUSES,
  reorderTasksBody,
  TASK_DETAIL_RELATIONS,
  TASK_RELATIONS,
  toTaskDetailDto,
  toTaskDto,
  updateTaskBody,
} from "./dto.js";

const idParams = z.object({ id: z.string().uuid() });

function isClosed(status: string): boolean {
  return (CLOSED_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Дата выполнения ставится и снимается автоматически. Руками её никто не
 * проставит, а без неё нельзя ответить на вопрос «сколько задач закрыли за
 * неделю» — и «выполнено» перестаёт отличаться от «висит с прошлого года».
 */
function completedAtFor(
  status: string | undefined,
  current: Date | null,
): Date | null | undefined {
  if (status === undefined) return undefined;
  if (isClosed(status)) return current ?? new Date();
  return null;
}

/** Чужой проект для сотрудника не существует, поэтому и ответ тот же, что на пустой id. */
async function assertReferences(
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

type TaskStatusValue = Prisma.EnumTaskStatusFilter["equals"] & string;

/**
 * Новая задача встаёт в конец своей колонки. На доске только верхний уровень. У двух
 * колонок одного типа номера свои; задача без колонки (отменённая, подзадача) считается
 * по статусу, как раньше.
 */
async function nextPosition(slot: {
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
function reachableTask(id: string, viewer: Viewer): Prisma.TaskWhereInput {
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

/**
 * Какие позиции займут переставленные задачи. Сотрудник присылает не всю колонку, а
 * только видимое, поэтому нумерация с нуля подняла бы его задачи выше чужих и дала бы им
 * одинаковые номера. Задачи меняются только теми местами, которые уже занимали сами.
 * Совпавшие номера разводятся: при равной позиции порядок на доске не определён.
 */
function ownSlots(positions: number[]): number[] {
  const slots: number[] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    const previous = slots.at(-1);
    slots.push(previous === undefined ? position : Math.max(position, previous + 1));
  }
  return slots;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", { preHandler: requireTeam }, async (request, reply) => {
    const query = listTasksQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const { status, scope, projectId, developer, standalone, overdue, search, archived } =
      query.data;
    // Видимость и срез по человеку в AND: `where.OR` ниже занят поиском, и одно OR
    // затёрло бы другое.
    const conditions: Prisma.TaskWhereInput[] = [taskScope(request.user!)];
    const where: Prisma.TaskWhereInput = {
      deletedAt: null,
      parentId: null,
      AND: conditions,
    };

    if (status) where.status = status;
    else if (scope === "open") where.status = { in: [...OPEN_TASK_STATUSES] };
    else if (scope === "closed") where.status = { in: [...CLOSED_TASK_STATUSES] };

    if (projectId) where.projectId = projectId;
    if (standalone) where.projectId = null;
    // Как и у самого человека: задача с его подзадачей тоже на нём, иначе админ в срезе
    // не увидел бы часть того, что человек видит у себя.
    if (developer) {
      const onDeveloper = { developers: { has: developer } };
      conditions.push({
        OR: [onDeveloper, { subtasks: { some: { deletedAt: null, ...onDeveloper } } }],
      });
    }

    if (overdue) {
      where.dueAt = { lt: new Date() };
      where.status = { in: [...OPEN_TASK_STATUSES] };
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    // Архив — в AND, как и видимость: `where.OR` занят поиском.
    const cutoff = archiveCutoff();
    if (archived === "only") conditions.push(archivedTaskWhere(cutoff));
    if (archived === "exclude") conditions.push({ NOT: archivedTaskWhere(cutoff) });

    const tasks = await prisma.task.findMany({
      where,
      // Архив растёт без конца, и потолок срезал бы свежие: там сначала недавно закрытые.
      orderBy:
        archived === "only"
          ? [{ completedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }]
          : [{ status: "asc" }, { position: "asc" }],
      include: TASK_RELATIONS,
      take: 1000,
    });

    const notes = await briefNotes(
      "task",
      tasks.map((item) => item.id),
      request.user!,
    );
    return reply.send({
      tasks: tasks.map((item) => ({
        ...toTaskDto(item),
        note: notes.get(item.id) ?? null,
      })),
    });
  });

  app.post("/tasks", { preHandler: requireTeam }, async (request, reply) => {
    const parsed = createTaskBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    const viewer = request.user!;
    const parentId = input.parentId ?? null;

    // Проект подзадачи всегда родительский, присланный ни на что не влияет.
    const problem = await assertReferences(
      viewer,
      parentId ? { developers: input.developers } : input,
    );
    if (problem) return reply.code(400).send({ error: problem });

    // Колонка сильнее статуса. У подзадачи колонки нет: на доске её не бывает.
    const requested = normalizeTaskStatus(input.status) ?? "todo";
    const placed = parentId
      ? ({ ok: true, columnId: null, status: requested } as const)
      : await placeCard(prisma, "task", {
          columnId: input.columnId ?? undefined,
          status: input.columnId ? undefined : requested,
        });
    if (!placed.ok) return reply.code(400).send({ error: placed.error });
    const status = placed.status as TaskStatusValue;
    const position = await nextPosition(placed);

    const created = await prisma.$transaction(async (tx) => {
      let projectId = input.projectId ?? null;

      if (parentId) {
        const parent = await readParent(tx, parentId, viewer);
        if (!parent) return { code: 404, error: "Задача не найдена" } as const;
        if (parent.parentId) {
          return { code: 400, error: "У подзадачи не бывает своих подзадач" } as const;
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
      return { task };
    });

    if (created.error) return reply.code(created.code).send({ error: created.error });
    const { task } = created;

    await audit(request, {
      entity: "tasks",
      entityId: task.id,
      action: "create",
      ...(input.notifyChat === false && { diff: { notifyChat: false } }),
    });

    // Заведённая сразу закрытой задача — запись задним числом, работы в ней нет.
    if (!isClosed(task.status)) {
      notifyTaskInBackground(task, task.developers, "created", viewer, request.log, {
        teamChat: input.notifyChat !== false,
      });
    }

    return reply.code(201).send({ task: toTaskDto(task) });
  });

  app.get("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const task = await prisma.task.findFirst({
      where: reachableTask(params.data.id, request.user!),
      include: TASK_DETAIL_RELATIONS,
    });
    if (!task) return reply.code(404).send({ error: "Задача не найдена" });

    return reply.send({
      task: toTaskDetailDto(task),
      notes: await listNotes("task", task.id, request.user!),
    });
  });

  app.patch("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateTaskBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const viewer = request.user!;
    const existing = await prisma.task.findFirst({
      where: reachableTask(params.data.id, viewer),
    });
    if (!existing) return reply.code(404).send({ error: "Задача не найдена" });

    const input = parsed.data;
    const movesSubtask =
      existing.parentId !== null &&
      input.projectId !== undefined &&
      input.projectId !== existing.projectId;
    if (movesSubtask) {
      return reply.code(400).send({ error: "Подзадача живёт в проекте своей задачи" });
    }

    const problem = await assertReferences(viewer, input);
    if (problem) return reply.code(400).send({ error: problem });

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
      if (!placed.ok) return reply.code(400).send({ error: placed.error });
      nextStatus = placed.status;
      if (placed.status !== existing.status || placed.columnId !== existing.columnId) {
        data.status = placed.status as TaskStatusValue;
        data.columnId = placed.columnId;
        data.position = await nextPosition(placed);
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

    await audit(request, {
      entity: "tasks",
      entityId: task.id,
      action: "update",
      ...(input.notifyChat === false && { diff: { notifyChat: false } }),
    });

    // Тэгаем только новых: форма присылает весь список при каждом сохранении, и
    // сравнение с прежним не даёт будить всех исполнителей из-за правки названия.
    const added = task.developers.filter((name) => !existing.developers.includes(name));
    if (added.length > 0 && !isClosed(task.status)) {
      notifyTaskInBackground(task, added, "assigned", viewer, request.log, {
        teamChat: input.notifyChat !== false,
      });
    }

    return reply.send({ task: toTaskDto(task) });
  });

  /** Порядок внутри одной колонки. Приходит целиком, применяется одной транзакцией. */
  app.put("/tasks/reorder", { preHandler: requireTeam }, async (request, reply) => {
    const parsed = reorderTasksBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const { columnId, ids } = parsed.data;
    const status = normalizeTaskStatus(parsed.data.status) as TaskStatusValue | undefined;
    const column = columnId
      ? await prisma.boardColumn.findFirst({
          where: { id: columnId, scope: "task" },
          select: { id: true, kind: true },
        })
      : null;
    if (columnId && !column) return reply.code(404).send({ error: "Колонка не найдена" });

    // Берём только те задачи, что действительно в этой колонке и видны этому человеку:
    // присланный список мог устареть, пока его тащили мышью, а мог быть подделан.
    // Подзадач на доске нет, их номера с номерами колонки не сравнимы. Задача без
    // колонки показана в первой колонке своего статуса, поэтому тоже своя.
    const existing = await prisma.task.findMany({
      where: {
        id: { in: ids },
        ...(column
          ? {
              OR: [
                { columnId: column.id },
                { columnId: null, status: column.kind as TaskStatusValue },
              ],
            }
          : { status }),
        deletedAt: null,
        parentId: null,
        AND: [taskScope(request.user!)],
      },
      select: { id: true, position: true },
    });
    const known = new Set(existing.map((task) => task.id));
    const slots = ownSlots(existing.map((task) => task.position));

    await prisma.$transaction(
      [...new Set(ids)]
        .filter((id) => known.has(id))
        .map((id, index) =>
          prisma.task.update({
            where: { id },
            data: { position: slots[index], ...(column && { columnId: column.id }) },
          }),
        ),
    );

    return reply.code(204).send();
  });

  app.delete("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const task = await prisma.task.findFirst({
      where: reachableTask(params.data.id, request.user!),
    });
    if (!task) return reply.code(404).send({ error: "Задача не найдена" });

    // Подзадачи не трогаем: они уходят в Корзину вместе с родителем сами собой, потому
    // что недоступны без него, и возвращаются с ним. Своя отметка удаления у подзадачи
    // значит только одно: её убрали отдельным решением.
    await prisma.task.update({
      where: { id: task.id },
      data: { deletedAt: new Date() },
    });

    await audit(request, {
      entity: "tasks",
      entityId: task.id,
      action: "delete",
      diff: { title: task.title, status: task.status },
    });

    return reply.code(204).send();
  });

  await noteRoutesFor(
    app,
    "task",
    "tasks",
    async (id, viewer) =>
      (await prisma.task.count({ where: reachableTask(id, viewer) })) > 0,
    "Задача не найдена",
    requireTeam,
  );
}
