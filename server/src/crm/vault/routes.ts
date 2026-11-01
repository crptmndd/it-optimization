import type { FastifyInstance } from "fastify";
import { requireTeam } from "../../auth/guard.js";
import { prisma } from "../../db.js";
import { LEGACY_PENDING } from "../credentials/dto.js";

/**
 * Остатки хранилища на мастер-фразе.
 *
 * Новые пароли шифрует сервер (`crm/credentials/routes.ts`), а старые лежат в колонке
 * `secret`, зашифрованные в браузере. Фразу не знает никто, кроме людей, поэтому их
 * переносит браузер: для этого ему нужны соль и контрольное значение, и больше ничего.
 *
 * `salt` и `verifier` отдаются без 2FA, потому что их читает ещё и старая CRM. Без
 * шифротекстов, которые закрыты кодом, подобранная фраза ничего не открывает. Убрать
 * следующим релизом вместе с остальной совместимостью.
 */

/** Всегда одна строка: ключ у команды был общий. */
const ROW_ID = "vault";

const GONE = "Мастер-фраза больше не используется";

export async function vaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/vault", { preHandler: requireTeam }, async (_request, reply) => {
    const row = await prisma.vaultSetting.findUnique({ where: { id: ROW_ID } });
    if (!row) return reply.send({ configured: false });

    // То же условие, что у выборки для переноса: иначе число на кнопке разойдётся
    // со списком.
    const secrets = await prisma.credential.count({ where: LEGACY_PENDING });
    return reply.send({
      configured: true,
      salt: row.salt,
      verifier: row.verifier,
      secrets,
    });
  });

  // Задать фразу и сбросить хранилище больше нельзя. Маршруты отвечают явным отказом,
  // а не 404: старая вкладка CRM покажет понятный текст. Сброс к тому же стёр бы
  // колонку `secret`, а она запас на случай отката API.
  app.post("/vault", { preHandler: requireTeam }, async (_request, reply) => {
    return reply.code(410).send({ error: GONE });
  });

  app.post("/vault/reset", { preHandler: requireTeam }, async (_request, reply) => {
    return reply.code(410).send({ error: GONE });
  });
}
