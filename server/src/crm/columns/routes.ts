import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin, requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { invalidInput } from "../http.js";
import { COLUMN_KINDS, COLUMN_SCOPES, isColumnKind, toColumnDto } from "./columns.js";

const idParams = z.object({ id: z.string().uuid() });
const title = z
  .string()
  .trim()
  .min(1, "Нужно название")
  .max(40, "Не длиннее 40 символов");
/** Больше на доске не помещается даже на 1920: колонки уходят в прокрутку и теряются. */
const MAX_COLUMNS = 12;

const createBody = z
  .object({ scope: z.enum(COLUMN_SCOPES), title, kind: z.string() })
  .refine((body) => isColumnKind(body.scope, body.kind), {
    message: "Неизвестный тип колонки",
    path: ["kind"],
  });
const updateBody = z.object({ title });
const orderBody = z.object({
  scope: z.enum(COLUMN_SCOPES),
  ids: z.array(z.string().uuid()).max(MAX_COLUMNS * 2),
});

export async function columnRoutes(app: FastifyInstance) {
  /** Колонки видит вся команда: сотрудник тоже двигает свои задачи по доске. */
  app.get("/board-columns", { preHandler: requireTeam }, async (_request, reply) => {
    const columns = await prisma.boardColumn.findMany({
      orderBy: [{ scope: "asc" }, { position: "asc" }],
    });
    return reply.send({ columns: columns.map(toColumnDto), kinds: COLUMN_KINDS });
  });

  app.post("/board-columns", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);
    const { scope, kind } = parsed.data;

    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM board_columns WHERE scope = ${scope} FOR UPDATE`;
      const count = await tx.boardColumn.count({ where: { scope } });
      if (count >= MAX_COLUMNS) return null;
      const last = await tx.boardColumn.aggregate({
        where: { scope },
        _max: { position: true },
      });
      return tx.boardColumn.create({
        data: {
          scope,
          kind,
          title: parsed.data.title,
          position: (last._max.position ?? -1) + 1,
        },
      });
    });
    if (!created) {
      return reply
        .code(409)
        .send({ error: `Больше ${MAX_COLUMNS} колонок не поместится` });
    }

    await audit(request, {
      entity: "board_columns",
      entityId: created.id,
      action: "create",
      diff: { scope, kind, title: created.title },
    });
    return reply.code(201).send({ column: toColumnDto(created) });
  });

  app.patch(
    "/board-columns/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);
      const parsed = updateBody.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const existing = await prisma.boardColumn.findUnique({
        where: { id: params.data.id },
      });
      if (!existing) return reply.code(404).send({ error: "Колонка не найдена" });

      const column = await prisma.boardColumn.update({
        where: { id: existing.id },
        data: { title: parsed.data.title },
      });
      await audit(request, {
        entity: "board_columns",
        entityId: column.id,
        action: "update",
        diff: { title: [existing.title, column.title] },
      });
      return reply.send({ column: toColumnDto(column) });
    },
  );

  /**
   * Порядок колонок одной доски целиком. Присланный список мог устареть, пока его
   * собирали: незнакомые id пропускаются, а не упомянутые колонки встают в конец в
   * прежнем порядке, чтобы ни одна не получила чужой номер.
   */
  app.put(
    "/board-columns/order",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = orderBody.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error);
      const { scope, ids } = parsed.data;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM board_columns WHERE scope = ${scope} FOR UPDATE`;
        const columns = await tx.boardColumn.findMany({
          where: { scope },
          orderBy: { position: "asc" },
          select: { id: true },
        });
        const known = new Set(columns.map((column) => column.id));
        const ordered = [...new Set(ids)].filter((id) => known.has(id));
        const rest = columns
          .map((column) => column.id)
          .filter((id) => !ordered.includes(id));
        await Promise.all(
          [...ordered, ...rest].map((id, position) =>
            tx.boardColumn.update({ where: { id }, data: { position } }),
          ),
        );
      });

      await audit(request, {
        entity: "board_columns",
        action: "reorder",
        diff: { scope },
      });
      return reply.code(204).send();
    },
  );

  /**
   * Карточки удалённой колонки переезжают в первую другую колонку того же типа, в её
   * конец: статус у них не меняется, поэтому ни счета, ни «Сегодня» удаление не задевает.
   * Последнюю колонку типа удалить нельзя, иначе этому статусу некуда было бы встать.
   * Строки досок держатся до конца транзакции: два одновременных удаления двух
   * последних колонок одного типа иначе прошли бы оба.
   */
  app.delete(
    "/board-columns/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const result = await prisma.$transaction(async (tx) => {
        const found = await tx.boardColumn.findUnique({ where: { id: params.data.id } });
        if (!found) return { ok: false, code: 404, error: "Колонка не найдена" } as const;
        await tx.$queryRaw`SELECT id FROM board_columns WHERE scope = ${found.scope} FOR UPDATE`;

        const target = await tx.boardColumn.findFirst({
          where: { scope: found.scope, kind: found.kind, id: { not: found.id } },
          orderBy: { position: "asc" },
        });
        if (!target) {
          return {
            ok: false,
            code: 409,
            error:
              "Это последняя колонка своего типа. Её можно переименовать, а удалить, только когда появится другая такого же типа",
          } as const;
        }

        let moved = 0;
        if (found.scope === "task") {
          const last = await tx.task.aggregate({
            where: { columnId: target.id },
            _max: { position: true },
          });
          const offset = (last._max.position ?? -1) + 1;
          const cards = await tx.task.findMany({
            where: { columnId: found.id },
            orderBy: { position: "asc" },
            select: { id: true },
          });
          await Promise.all(
            cards.map((card, index) =>
              tx.task.update({
                where: { id: card.id },
                data: { columnId: target.id, position: offset + index },
              }),
            ),
          );
          moved = cards.length;
        } else {
          const last = await tx.project.aggregate({
            where: { columnId: target.id },
            _max: { position: true },
          });
          const offset = (last._max.position ?? -1) + 1;
          const cards = await tx.project.findMany({
            where: { columnId: found.id },
            orderBy: { position: "asc" },
            select: { id: true },
          });
          await Promise.all(
            cards.map((card, index) =>
              tx.project.update({
                where: { id: card.id },
                data: { columnId: target.id, position: offset + index },
              }),
            ),
          );
          moved = cards.length;
        }

        await tx.boardColumn.delete({ where: { id: found.id } });
        return { ok: true, found, target, moved } as const;
      });

      if (!result.ok) return reply.code(result.code).send({ error: result.error });

      await audit(request, {
        entity: "board_columns",
        entityId: result.found.id,
        action: "delete",
        diff: {
          scope: result.found.scope,
          title: result.found.title,
          movedTo: result.target.title,
          moved: result.moved,
        },
      });
      return reply.send({ movedTo: toColumnDto(result.target), moved: result.moved });
    },
  );
}
