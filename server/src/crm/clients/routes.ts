// Prisma нужен как значение (Prisma.DbNull), поэтому обычный импорт.
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { invalidInput } from "../http.js";
import { briefNotes, listNotes, noteRoutesFor } from "../notes.js";
import {
  createClientBody,
  listClientsQuery,
  toClientDto,
  updateClientBody,
} from "./dto.js";

const idParams = z.object({ id: z.string().uuid() });

/** Проекты подтягиваются только ради счётчиков в списке — отсюда узкий select. */
const WITH_PROJECT_STATUSES = {
  projects: { where: { deletedAt: null }, select: { status: true, archivedAt: true } },
} as const;

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get("/clients", { preHandler: requireAdmin }, async (request, reply) => {
    const query = listClientsQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const { search } = query.data;
    const where: Prisma.ClientWhereInput = { deletedAt: null };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { inn: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    const clients = await prisma.client.findMany({
      where,
      orderBy: { name: "asc" },
      include: WITH_PROJECT_STATUSES,
      take: 500,
    });

    const notes = await briefNotes(
      "client",
      clients.map((item) => item.id),
      request.user!,
    );
    return reply.send({
      clients: clients.map((item) => ({
        ...toClientDto(item),
        note: notes.get(item.id) ?? null,
      })),
    });
  });

  app.post("/clients", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createClientBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    const client = await prisma.client.create({
      data: {
        name: input.name,
        inn: input.inn ?? null,
        site: input.site ?? null,
        contacts: input.contacts ?? undefined,
        notes: input.notes ?? null,
      },
      include: WITH_PROJECT_STATUSES,
    });

    await audit(request, { entity: "clients", entityId: client.id, action: "create" });
    return reply.code(201).send({ client: toClientDto(client) });
  });

  app.get("/clients/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const client = await prisma.client.findFirst({
      where: { id: params.data.id, deletedAt: null },
      include: WITH_PROJECT_STATUSES,
    });
    if (!client) return reply.code(404).send({ error: "Клиент не найден" });

    return reply.send({
      client: toClientDto(client),
      notes: await listNotes("client", client.id, request.user!),
    });
  });

  app.patch("/clients/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateClientBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const existing = await prisma.client.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Клиент не найден" });

    const input = parsed.data;
    const data: Prisma.ClientUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.inn !== undefined) data.inn = input.inn;
    if (input.site !== undefined) data.site = input.site;
    if (input.notes !== undefined) data.notes = input.notes;
    // null означает «очистить список», поэтому Prisma.DbNull, а не undefined:
    // undefined он трактует как «поле не трогать».
    if (input.contacts !== undefined) {
      data.contacts = input.contacts === null ? Prisma.DbNull : input.contacts;
    }

    const client = await prisma.client.update({
      where: { id: existing.id },
      data,
      include: WITH_PROJECT_STATUSES,
    });

    await audit(request, { entity: "clients", entityId: client.id, action: "update" });
    return reply.send({ client: toClientDto(client) });
  });

  app.delete("/clients/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const existing = await prisma.client.findFirst({
      where: { id: params.data.id, deletedAt: null },
      include: { projects: { where: { deletedAt: null }, select: { id: true } } },
    });
    if (!existing) return reply.code(404).send({ error: "Клиент не найден" });

    // Клиент с проектами не удаляется: иначе в проектах остаётся ссылка в
    // никуда, и непонятно, чья это была работа. Архивные считаются тоже: они
    // так же показывают, чья это была работа.
    if (existing.projects.length > 0) {
      return reply.code(409).send({
        error: `Сначала удалите или перенесите проекты клиента (${existing.projects.length})`,
      });
    }

    await prisma.client.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    await audit(request, { entity: "clients", entityId: existing.id, action: "delete" });
    return reply.code(204).send();
  });

  await noteRoutesFor(
    app,
    "client",
    "clients",
    async (id) => (await prisma.client.count({ where: { id, deletedAt: null } })) > 0,
    "Клиент не найден",
    requireAdmin,
  );
}
