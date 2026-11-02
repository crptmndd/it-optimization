import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin } from "../../auth/guard.js";
import { notifyNewLeadInBackground } from "../../notify/notifications.js";
import { prisma } from "../../db.js";
import { invalidInput } from "../http.js";
import { briefNotes, createNote, listNotes } from "../notes.js";
import {
  CLOSED_LEAD_STATUSES,
  createLeadBody,
  createNoteBody,
  LEAD_RELATIONS,
  listLeadsQuery,
  OPEN_LEAD_STATUSES,
  toLeadDto,
  updateLeadBody,
  type LeadDto,
} from "./dto.js";

const idParams = z.object({ id: z.string().uuid() });

/**
 * Закрытому лиду следующий шаг не нужен: он только засорял бы утренний
 * дайджест. Поэтому и дата, и описание снимаются автоматически, а не силами
 * того, кто помнит про них в момент закрытия.
 *
 * Для PATCH важно вернуть именно `{}`, когда поля не приходили: пустой объект
 * при разворачивании не тронет то, что уже лежит в базе.
 */
function nextStepFor(
  status: string | undefined,
  at: Date | null | undefined,
  note: string | null | undefined,
): { nextActionAt?: Date | null; nextActionNote?: string | null } {
  if (status === "won" || status === "lost") {
    return { nextActionAt: null, nextActionNote: null };
  }
  const step: { nextActionAt?: Date | null; nextActionNote?: string | null } = {};
  if (at !== undefined) step.nextActionAt = at;
  if (note !== undefined) step.nextActionNote = note;
  return step;
}

/**
 * Ссылки на пользователя и клиента проверяются заранее: без этого Prisma
 * бросает ошибку внешнего ключа, и наружу уходит 500 вместо внятного «не
 * найден».
 */
async function assertReferences(input: {
  ownerId?: string | null;
  clientId?: string | null;
}): Promise<string | null> {
  if (input.ownerId) {
    const owner = await prisma.user.findFirst({
      where: { id: input.ownerId, disabledAt: null },
    });
    if (!owner) return "Такого пользователя нет";
  }
  if (input.clientId) {
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    });
    if (!client) return "Такого клиента нет";
  }
  return null;
}

async function findLead(id: string): Promise<LeadDto | null> {
  const lead = await prisma.lead.findFirst({
    where: { id, deletedAt: null },
    include: LEAD_RELATIONS,
  });
  return lead ? toLeadDto(lead) : null;
}

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/leads", { preHandler: requireAdmin }, async (request, reply) => {
    const query = listLeadsQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const { status, scope, ownerId, overdue, search } = query.data;

    const where: Prisma.LeadWhereInput = { deletedAt: null };
    if (ownerId) where.ownerId = ownerId;

    // Точный статус важнее среза, срез важнее «всех».
    if (status) {
      where.status = status;
    } else if (scope === "open") {
      where.status = { in: [...OPEN_LEAD_STATUSES] };
    } else if (scope === "closed") {
      where.status = { in: [...CLOSED_LEAD_STATUSES] };
    }

    if (overdue) {
      // Просрочен — это не только «дата в прошлом»: у закрытого лида следующего
      // шага нет вовсе, и он не должен всплывать в этом фильтре.
      if (!status) where.status = { in: [...OPEN_LEAD_STATUSES] };
      where.nextActionAt = { lt: new Date() };
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { contact: { contains: search, mode: "insensitive" } },
        { message: { contains: search, mode: "insensitive" } },
      ];
    }

    const leads = await prisma.lead.findMany({
      where,
      include: LEAD_RELATIONS,
      // Сначала те, у кого назначен следующий шаг, — по дате. Лиды без даты
      // уходят вниз: nulls last, иначе они занимают верх списка и прячут то,
      // что горит.
      orderBy: [{ nextActionAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 500,
    });

    // Последняя заметка едет вместе со списком: без неё «о чём мы вообще
    // договорились» видно только внутри карточки, а туда лишний раз не ходят.
    const notes = await briefNotes(
      "lead",
      leads.map((item) => item.id),
      request.user!,
    );
    return reply.send({
      leads: leads.map((item) => ({
        ...toLeadDto(item),
        note: notes.get(item.id) ?? null,
      })),
    });
  });

  app.post("/leads", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createLeadBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    const lead = await prisma.lead.create({
      data: {
        name: input.name ?? null,
        contact: input.contact,
        message: input.message ?? null,
        channel: input.channel ?? null,
        status: input.status ?? "new",
        ownerId: input.ownerId ?? null,
        clientId: input.clientId ?? null,
        lostReason: input.lostReason ?? null,
        service: input.service ?? null,
        nextActionAt: null,
        nextActionNote: null,
        ...nextStepFor(input.status, input.nextActionAt, input.nextActionNote),
      },
      include: LEAD_RELATIONS,
    });

    await audit(request, { entity: "leads", entityId: lead.id, action: "create" });
    // Не ждём отправку: лид уже сохранён, а телеграм может лежать.
    notifyNewLeadInBackground(lead, request.log);
    return reply.code(201).send({ lead: toLeadDto(lead) });
  });

  app.get("/leads/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const lead = await findLead(params.data.id);
    if (!lead) return reply.code(404).send({ error: "Лид не найден" });

    return reply.send({ lead, notes: await listNotes("lead", lead.id, request.user!) });
  });

  app.patch("/leads/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateLeadBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const before = await findLead(params.data.id);
    if (!before) return reply.code(404).send({ error: "Лид не найден" });

    const input = parsed.data;
    const problem = await assertReferences(input);
    if (problem) return reply.code(400).send({ error: problem });

    // Поле, которого нет в теле запроса, остаётся как было: PATCH правит
    // названное, а не присланное целиком.
    const data: Prisma.LeadUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.contact !== undefined) data.contact = input.contact;
    if (input.message !== undefined) data.message = input.message;
    if (input.channel !== undefined) data.channel = input.channel;
    if (input.status !== undefined) data.status = input.status;
    if (input.lostReason !== undefined) data.lostReason = input.lostReason;
    if (input.service !== undefined) data.service = input.service;
    if (input.ownerId !== undefined) {
      data.owner = input.ownerId
        ? { connect: { id: input.ownerId } }
        : { disconnect: true };
    }
    if (input.clientId !== undefined) {
      data.client = input.clientId
        ? { connect: { id: input.clientId } }
        : { disconnect: true };
    }

    Object.assign(
      data,
      nextStepFor(input.status, input.nextActionAt, input.nextActionNote),
    );

    const lead = await prisma.lead.update({
      where: { id: params.data.id },
      data,
      include: LEAD_RELATIONS,
    });

    const after = toLeadDto(lead);
    await audit(request, {
      entity: "leads",
      entityId: lead.id,
      action: "update",
      diff: { before: { ...before }, after: { ...after } },
    });

    return reply.send({ lead: after });
  });

  app.delete("/leads/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const lead = await findLead(params.data.id);
    if (!lead) return reply.code(404).send({ error: "Лид не найден" });

    // Мягкое удаление: обращение исчезает из списка, но остаётся в базе — по
    // нему ещё может прийти вопрос «а что это было в марте».
    await prisma.lead.update({
      where: { id: lead.id },
      data: { deletedAt: new Date() },
    });

    await audit(request, {
      entity: "leads",
      entityId: lead.id,
      action: "delete",
      diff: { contact: lead.contact, status: lead.status },
    });

    return reply.code(204).send();
  });

  app.post("/leads/:id/notes", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = createNoteBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const lead = await findLead(params.data.id);
    if (!lead) return reply.code(404).send({ error: "Лид не найден" });

    const note = await createNote("lead", lead.id, request.user!.id, parsed.data.body);
    return reply.code(201).send({ note });
  });
}
