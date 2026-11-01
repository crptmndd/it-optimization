import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { notifyTaskInBackground } from "../../notify/notifications.js";
import { invalidInput } from "../http.js";
import { briefNotes, listNotes, noteRoutesFor } from "../notes.js";
import {
  CLOSED_TASK_STATUSES,
  createTaskBody,
  listTasksQuery,
  OPEN_TASK_STATUSES,
  reorderTasksBody,
  TASK_RELATIONS,
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

async function assertReferences(input: {
  projectId?: string | null;
}): Promise<string | null> {
  if (input.projectId) {
    const found = await prisma.project.count({
      where: { id: input.projectId, deletedAt: null },
    });
    if (!found) return "Проект не найден";
  }
  return null;
}

/** Новая задача встаёт в конец своей колонки. */
async function nextPosition(status: string): Promise<number> {
  const last = await prisma.task.aggregate({
    where: { status: status as Prisma.EnumTaskStatusFilter["equals"], deletedAt: null },
    _max: { position: true },
  });
  return (last._max.position ?? -1) + 1;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tasks", { preHandler: requireTeam }, async (request, reply) => {
    const query = listTasksQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const { status, scope, projectId, developer, standalone, overdue, search } =
      query.data;
    const where: Prisma.TaskWhereInput = { deletedAt: null };

    if (status) where.status = status;
    else if (scope === "open") where.status = { in: [...OPEN_TASK_STATUSES] };
    else if (scope === "closed") where.status = { in: [...CLOSED_TASK_STATUSES] };

    if (projectId) where.projectId = projectId;
    if (standalone) where.projectId = null;
    if (developer) where.developers = { has: developer };

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

    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ status: "asc" }, { position: "asc" }],
      include: TASK_RELATIONS,
      take: 1000,
    });

    const notes = await briefNotes("task", tasks.map((item) => item.id));
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
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    const status = input.status ?? "todo";
    const task = await prisma.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        status,
        priority: input.priority ?? "normal",
        projectId: input.projectId ?? null,
        developers: input.developers ?? [],
        createdById: request.user!.id,
        dueAt: input.dueAt ?? null,
        completedAt: completedAtFor(status, null) ?? null,
        position: await nextPosition(status),
      },
      include: TASK_RELATIONS,
    });

    await audit(request, { entity: "tasks", entityId: task.id, action: "create" });

    // Заведённая сразу закрытой задача — запись задним числом, работы в ней нет.
    if (!isClosed(task.status)) {
      notifyTaskInBackground(task, task.developers, "created", request.log);
    }

    return reply.code(201).send({ task: toTaskDto(task) });
  });

  app.get("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const task = await prisma.task.findFirst({
      where: { id: params.data.id, deletedAt: null },
      include: TASK_RELATIONS,
    });
    if (!task) return reply.code(404).send({ error: "Задача не найдена" });

    return reply.send({
      task: toTaskDto(task),
      notes: await listNotes("task", task.id),
    });
  });

  app.patch("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateTaskBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const existing = await prisma.task.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Задача не найдена" });

    const input = parsed.data;
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.projectId !== undefined) data.projectId = input.projectId;
    if (input.developers !== undefined) data.developers = input.developers;
    if (input.dueAt !== undefined) data.dueAt = input.dueAt;

    // Смена статуса — это переезд в другую колонку, поэтому задача встаёт в её
    // конец. Иначе она приземлилась бы в середину по старому номеру позиции.
    if (input.status !== undefined && input.status !== existing.status) {
      data.status = input.status;
      data.position = await nextPosition(input.status);
    }

    const completedAt = completedAtFor(input.status, existing.completedAt);
    if (completedAt !== undefined) data.completedAt = completedAt;

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
      include: TASK_RELATIONS,
    });

    await audit(request, { entity: "tasks", entityId: task.id, action: "update" });

    // Тэгаем только новых: форма присылает весь список при каждом сохранении, и
    // сравнение с прежним не даёт будить всех исполнителей из-за правки названия.
    const added = task.developers.filter((name) => !existing.developers.includes(name));
    if (added.length > 0 && !isClosed(task.status)) {
      notifyTaskInBackground(task, added, "assigned", request.log);
    }

    return reply.send({ task: toTaskDto(task) });
  });

  /** Порядок внутри одной колонки. Приходит целиком, применяется одной транзакцией. */
  app.put("/tasks/reorder", { preHandler: requireTeam }, async (request, reply) => {
    const parsed = reorderTasksBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const { status, ids } = parsed.data;

    // Берём только те задачи, что действительно в этой колонке: присланный
    // список мог устареть, пока его тащили мышью.
    const existing = await prisma.task.findMany({
      where: { id: { in: ids }, status, deletedAt: null },
      select: { id: true },
    });
    const known = new Set(existing.map((task) => task.id));

    await prisma.$transaction(
      ids
        .filter((id) => known.has(id))
        .map((id, index) =>
          prisma.task.update({ where: { id }, data: { position: index } }),
        ),
    );

    return reply.code(204).send();
  });

  app.delete("/tasks/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const task = await prisma.task.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!task) return reply.code(404).send({ error: "Задача не найдена" });

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
    async (id) => (await prisma.task.count({ where: { id, deletedAt: null } })) > 0,
    "Задача не найдена",
    requireTeam,
  );
}
