import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireAdmin } from "../../auth/guard.js";
import { invalidInput } from "../http.js";
import { deleteNotes } from "../notes.js";
import { purgeDeleted } from "./purge.js";
import { RETENTION_DAYS, TRASH, TRASH_ENTITIES } from "./registry.js";

/**
 * Корзина — один экран на все сущности вместо шести кнопок «восстановить».
 *
 * Записи здесь уже не видны в своих разделах, поэтому список плоский: что это
 * было, как называлось и сколько ещё пролежит.
 */

const entity = z.enum(TRASH_ENTITIES);
const targetBody = z.object({ entity, id: z.string().uuid() });

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  app.get("/trash", { preHandler: requireAdmin }, async (_request, reply) => {
    const groups = await Promise.all(
      Object.entries(TRASH).map(async ([key, model]) => {
        const entries = await model.list();
        return entries.map((entry) => ({
          entity: key,
          label: model.label,
          id: entry.id,
          title: entry.title,
          deletedAt: entry.deletedAt.toISOString(),
        }));
      }),
    );

    // Свежеудалённое сверху: если человек пришёл что-то вернуть, оно там.
    const items = groups.flat().sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));

    return reply.send({ items, retentionDays: RETENTION_DAYS });
  });

  app.post("/trash/restore", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = targetBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const model = TRASH[parsed.data.entity];
    await model.restore(parsed.data.id);

    await audit(request, {
      entity: parsed.data.entity,
      entityId: parsed.data.id,
      action: "restore",
    });
    return reply.code(204).send();
  });

  /**
   * Удалить сейчас, не дожидаясь срока. Нужно не для порядка, а для данных,
   * которым не место в базе лишний месяц: контакты человека, попросившего его
   * забыть, или доступ к сервису, с которым разошлись.
   */
  app.post("/trash/purge", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = targetBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const model = TRASH[parsed.data.entity];
    await model.purgeOne(parsed.data.id);
    if (model.notes) await deleteNotes(model.notes, parsed.data.id);

    await audit(request, {
      entity: parsed.data.entity,
      entityId: parsed.data.id,
      action: "purge",
    });
    return reply.code(204).send();
  });

  /**
   * Очистить корзину целиком.
   *
   * Тот же код, что и в суточной уборке, но с нулевым сроком: «удалить всё,
   * что старше нуля дней» — это и есть «удалить всё». Отдельной реализации
   * заводить незачем, иначе две логики удаления однажды разойдутся.
   */
  app.post("/trash/empty", { preHandler: requireAdmin }, async (request, reply) => {
    const purged = await purgeDeleted(0);

    await audit(request, { entity: "trash", action: "empty", diff: { purged } });
    return reply.send({ purged });
  });
}
