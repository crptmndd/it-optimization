import type { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin, requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import {
  notifyNewProjectInBackground,
  notifyProjectAssignedInBackground,
} from "../../notify/notifications.js";
import { projectScope } from "../access.js";
import { invalidInput } from "../http.js";
import { briefNotes, listNotes, noteRoutesFor } from "../notes.js";
import { assertDevelopers } from "../people.js";
import { invoiceRoutes } from "./invoices.js";
import { rememberUnbilledMonth } from "./monthly-documents.js";
import {
  billingMode,
  CLOSED_PROJECT_STATUSES,
  createProjectBody,
  currentPeriod,
  nextBillingMonthly,
  reorderProjectsBody,
  listProjectsQuery,
  OPEN_PROJECT_STATUSES,
  PROJECT_RELATIONS,
  projectDtoFor,
  projectRelationsFor,
  toProjectDto,
  updateProjectBody,
} from "./dto.js";
import { ensureStages, stageRoutes, STAGE_POSITIONS } from "./stages.js";

const idParams = z.object({ id: z.string().uuid() });

/**
 * Закрытие проставляет дату закрытия, возврат в работу — снимает. Иначе в
 * списке закрытых оказываются записи без даты, и непонятно, когда всё
 * закончилось.
 */
function closedAtFor(
  status: string | undefined,
  current: Date | null,
): Date | null | undefined {
  if (status === undefined) return undefined;
  const closed = (CLOSED_PROJECT_STATUSES as readonly string[]).includes(status);
  if (closed) return current ?? new Date();
  return null;
}

/**
 * Ссылки на клиента, лид и исполнителя проверяем до записи: иначе опечатка в
 * идентификаторе превращается в ошибку внешнего ключа, а наружу летит
 * невнятная «внутренняя ошибка сервера».
 */
async function assertReferences(input: {
  clientId?: string | null;
  leadId?: string | null;
  developers?: string[];
}): Promise<string | null> {
  if (input.clientId) {
    const found = await prisma.client.count({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!found) return "Клиент не найден";
  }
  if (input.leadId) {
    const found = await prisma.lead.count({
      where: { id: input.leadId, deletedAt: null },
    });
    if (!found) return "Лид не найден";
  }
  return assertDevelopers(input.developers);
}

/**
 * Архив — отдельный признак, а не статус: проект сохраняет итог («сдан»,
 * «отменён»), а статус говорит о работе, а не о том, видно ли её.
 *
 * Условие стоит в самом запросе, поэтому повтор не сдвигает дату архивации и не
 * пишет в журнал второй раз.
 */
function archiveHandler(action: "archive" | "unarchive") {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const { id } = params.data;
    const archive = action === "archive";
    const count = await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({
        where: { id, deletedAt: null, archivedAt: archive ? null : { not: null } },
        data: { archivedAt: archive ? new Date() : null },
      });
      if (count > 0) await rememberUnbilledMonth(tx, id);
      return count;
    });

    const project = await prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: PROJECT_RELATIONS,
    });
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    if (count > 0) await audit(request, { entity: "projects", entityId: id, action });
    return reply.send({ project: toProjectDto(project, env.TIMEZONE) });
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/projects", { preHandler: requireTeam }, async (request, reply) => {
    const query = listProjectsQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const { status, scope, clientId, archived, developer, overdue, search } = query.data;
    // В AND: ниже есть `where.OR` поиска, а условие видимости сотрудника тоже с OR.
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      AND: [projectScope(request.user!)],
    };

    if (archived === "exclude") where.archivedAt = null;
    else if (archived === "only") where.archivedAt = { not: null };

    if (status) where.status = status;
    else if (scope === "open") where.status = { in: [...OPEN_PROJECT_STATUSES] };
    else if (scope === "closed") where.status = { in: [...CLOSED_PROJECT_STATUSES] };

    if (clientId) where.clientId = clientId === "none" ? null : clientId;
    if (developer) where.developers = { has: developer };

    if (overdue) {
      where.deadline = { lt: new Date() };
      // Просроченным может быть только незакрытый проект: у закрытого срок уже
      // не имеет значения.
      where.status = { in: [...OPEN_PROJECT_STATUSES] };
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { client: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const projects = await prisma.project.findMany({
      where,
      // Сначала те, у кого горит срок; проекты без срока — в конце. Срок в архиве
      // уже ничего не значит, там сверху то, что убрали недавно.
      orderBy:
        archived === "only"
          ? [{ archivedAt: "desc" }]
          : [{ deadline: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      include: projectRelationsFor(request.user!),
      take: 500,
    });

    const notes = await briefNotes(
      "project",
      projects.map((item) => item.id),
      request.user!,
    );
    return reply.send({
      projects: projects.map((item) => ({
        ...projectDtoFor(request.user!, item, env.TIMEZONE),
        note: notes.get(item.id) ?? null,
      })),
    });
  });

  app.post("/projects", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createProjectBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    const status = input.status ?? "planned";
    const currency = input.currency ?? "rub";
    const project = await prisma.project.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        status,
        clientId: input.clientId ?? null,
        leadId: input.leadId ?? null,
        developers: input.developers ?? [],
        hosting: input.hosting ?? null,
        workType: input.workType ?? null,
        contractNumber: input.contractNumber ?? null,
        contractDate: input.contractDate ?? null,
        billingMonthly: nextBillingMonthly(input),
        monthlyAmountMinor: input.monthlyAmountMinor ?? null,
        currency,
        startedAt: input.startedAt ?? null,
        deadline: input.deadline ?? null,
        closedAt: closedAtFor(status, null) ?? null,
        ...(input.workType === "contract" && {
          stages: {
            create: STAGE_POSITIONS.map((position) => ({ position, currency })),
          },
        }),
      },
      include: PROJECT_RELATIONS,
    });

    await audit(request, { entity: "projects", entityId: project.id, action: "create" });

    // Заведённый сразу закрытым проект — запись задним числом, работы в нём нет.
    if (!project.closedAt) {
      notifyNewProjectInBackground(project, request.user!, request.log);
    }
    return reply.code(201).send({ project: toProjectDto(project, env.TIMEZONE) });
  });

  app.get("/projects/:id", { preHandler: requireTeam }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    // Чужой проект отвечает как несуществующий: 403 подтвердил бы, что он есть.
    const project = await prisma.project.findFirst({
      where: { id: params.data.id, deletedAt: null, AND: [projectScope(request.user!)] },
      include: projectRelationsFor(request.user!),
    });
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    return reply.send({
      project: projectDtoFor(request.user!, project, env.TIMEZONE),
      notes: await listNotes("project", project.id, request.user!),
    });
  });

  app.patch("/projects/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateProjectBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const existing = await prisma.project.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Проект не найден" });

    const input = parsed.data;
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    const data: Prisma.ProjectUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.status !== undefined) data.status = input.status;
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.leadId !== undefined) data.leadId = input.leadId;
    // Состав приходит целиком — записываем как есть.
    if (input.developers !== undefined) data.developers = input.developers;
    if (input.hosting !== undefined) data.hosting = input.hosting;
    if (input.workType !== undefined) data.workType = input.workType;
    if (input.contractNumber !== undefined) data.contractNumber = input.contractNumber;
    if (input.contractDate !== undefined) data.contractDate = input.contractDate;
    if (input.monthlyAmountMinor !== undefined)
      data.monthlyAmountMinor = input.monthlyAmountMinor;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.startedAt !== undefined) data.startedAt = input.startedAt;
    if (input.deadline !== undefined) data.deadline = input.deadline;

    const closedAt = closedAtFor(input.status, existing.closedAt);
    if (closedAt !== undefined) data.closedAt = closedAt;

    // Итог этой записи: режим оплаты зависит от него, а не от прежних значений.
    const workType = input.workType !== undefined ? input.workType : existing.workType;
    const billingMonthly = nextBillingMonthly(input, existing);
    const currency = input.currency ?? existing.currency;
    data.billingMonthly = billingMonthly;

    const project = await prisma.$transaction(async (tx) => {
      // Уход с договора этапы не удаляет: в них могут быть оплаты, а возврат на
      // договор вернёт те же строки. В одной транзакции, чтобы ответ уже их содержал.
      if (workType === "contract") await ensureStages(tx, existing.id, currency);

      // Сумма появилась позже автодокументов: иначе первый месяц пришлось бы
      // править руками в двух записях. Проверка режима нужна потому, что старая
      // форма шлёт сумму при каждом сохранении, и у разового проекта с оставшейся
      // суммой она молча попала бы в ручную запись.
      const amountMinor = input.monthlyAmountMinor;
      if (
        amountMinor !== undefined &&
        amountMinor !== null &&
        billingMode({ workType, billingMonthly }) === "monthly"
      ) {
        await tx.invoice.updateMany({
          where: {
            projectId: existing.id,
            period: currentPeriod(env.TIMEZONE),
            amountMinor: null,
            paidAt: null,
          },
          data: { amountMinor, currency },
        });
      }

      const updated = await tx.project.update({
        where: { id: existing.id },
        data,
        include: PROJECT_RELATIONS,
      });
      await rememberUnbilledMonth(tx, existing.id);
      return updated;
    });

    await audit(request, {
      entity: "projects",
      entityId: project.id,
      action: "update",
      diff: { status: { from: existing.status, to: project.status } },
    });

    // Как у задач: состав приходит целиком, поэтому будим только добавленных.
    const added = project.developers.filter(
      (name) => !existing.developers.includes(name),
    );
    if (added.length > 0 && !project.closedAt) {
      notifyProjectAssignedInBackground(project, added, request.user!, request.log);
    }

    return reply.send({ project: toProjectDto(project, env.TIMEZONE) });
  });

  /** Порядок внутри колонки на доске. Приходит целиком, как и у задач. */
  app.put("/projects/reorder", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = reorderProjectsBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const { status, ids } = parsed.data;

    // Берём только те, что действительно в этой колонке: присланный список мог
    // устареть, пока его тащили мышью. Архива на доске нет.
    const existing = await prisma.project.findMany({
      where: { id: { in: ids }, status, deletedAt: null, archivedAt: null },
      select: { id: true },
    });
    const known = new Set(existing.map((project) => project.id));

    await prisma.$transaction(
      ids
        .filter((id) => known.has(id))
        .map((id, index) =>
          prisma.project.update({ where: { id }, data: { position: index } }),
        ),
    );

    return reply.code(204).send();
  });

  app.post(
    "/projects/:id/archive",
    { preHandler: requireAdmin },
    archiveHandler("archive"),
  );
  app.post(
    "/projects/:id/unarchive",
    { preHandler: requireAdmin },
    archiveHandler("unarchive"),
  );

  await invoiceRoutes(app);
  await stageRoutes(app);

  app.delete("/projects/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const project = await prisma.project.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    // Задачи проекта уходят вместе с ним: у задачи вне проекта, который её
    // породил, нет смысла. Мягко, как и сам проект.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: { deletedAt: new Date() },
      });
      await tx.task.updateMany({
        where: { projectId: project.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await rememberUnbilledMonth(tx, project.id);
    });

    await audit(request, {
      entity: "projects",
      entityId: project.id,
      action: "delete",
      diff: { title: project.title, status: project.status },
    });

    return reply.code(204).send();
  });

  await noteRoutesFor(
    app,
    "project",
    "projects",
    async (id, viewer) =>
      (await prisma.project.count({
        where: { id, deletedAt: null, AND: [projectScope(viewer)] },
      })) > 0,
    "Проект не найден",
    requireTeam,
  );
}
