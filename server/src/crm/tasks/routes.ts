import type { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { attachmentRoutes } from "./attachments.js";
import { requireAdmin, requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import {
  actorName,
  afterTaskUpdate,
  notifyTaskInBackground,
} from "../../notify/notifications.js";
import { taskScope } from "../access.js";
import { invalidInput } from "../http.js";
import { briefNotes, listNotes, noteRoutesFor } from "../notes.js";
import { normalizeTaskStatus } from "../columns/columns.js";
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
import {
  createTask,
  isClosed,
  reachableTask,
  setTaskArchived,
  type TaskStatusValue,
  updateTask,
} from "./service.js";

const idParams = z.object({ id: z.string().uuid() });

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
    const created = await createTask(request.user!, input);
    if (!created.ok) return reply.code(created.code).send({ error: created.error });
    const { task } = created;

    await audit(request, {
      entity: "tasks",
      entityId: task.id,
      action: "create",
      ...(input.notifyChat === false && { diff: { notifyChat: false } }),
    });

    // Заведённая сразу закрытой задача — запись задним числом, работы в ней нет.
    if (!isClosed(task.status)) {
      notifyTaskInBackground(task, task.developers, request.log, {
        teamChat: input.notifyChat !== false,
        skip: request.user!.memberName,
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

    const input = parsed.data;
    const updated = await updateTask(request.user!, params.data.id, input);
    if (!updated.ok) return reply.code(updated.code).send({ error: updated.error });
    const { task, existing } = updated;

    await audit(request, {
      entity: "tasks",
      entityId: task.id,
      action: "update",
      ...(input.notifyChat === false && { diff: { notifyChat: false } }),
    });

    afterTaskUpdate(
      {
        existing,
        task,
        actor: { id: request.user!.id, name: actorName(request.user!) },
        teamChat: input.notifyChat !== false,
      },
      request.log,
    );

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

  /**
   * Ручной архив: админ убирает задачу с доски, из «Сегодня» и сводки, даже открытую.
   * Подзадача уходит и возвращается только со своей задачей: своей строки на доске у неё
   * нет. Возврат снимает только ручную отметку: закрытая больше трёх дней назад остаётся
   * в архиве по возрасту, и вернуть её можно, только вернув в работу.
   */
  const archiveHandler =
    (archived: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const result = await setTaskArchived(request.user!, params.data.id, archived);
      if (!result.ok) return reply.code(result.code).send({ error: result.error });
      const { task } = result;
      await audit(request, {
        entity: "tasks",
        entityId: task.id,
        action: archived ? "archive" : "unarchive",
      });
      return reply.send({ task: toTaskDto(task) });
    };

  app.post("/tasks/:id/archive", { preHandler: requireAdmin }, archiveHandler(true));
  app.post("/tasks/:id/unarchive", { preHandler: requireAdmin }, archiveHandler(false));

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

  await attachmentRoutes(app);
}
