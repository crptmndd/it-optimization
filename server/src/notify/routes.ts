import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireCrmOrigin, requireTeam } from "../auth/guard.js";
import { verifyPassword } from "../auth/password.js";
import { prisma } from "../db.js";
import { canNotify } from "../env.js";

/**
 * Привязка телеграма — только для команды.
 *
 * Бот шлёт сводку по всем проектам, задачам и деньгам; маркетолог ведёт лиды и
 * этой картины видеть не должен. Раз сводка общая, привязываться к боту ему
 * незачем.
 *
 * Привязанный чат читает `/today` мимо сессий, поэтому код выдаётся только по паролю и
 * только из CRM: иначе украденная кука оставила бы своему чату доступ, который
 * переживает выход и отзыв всех сессий. Смена пароля и включение 2FA привязку снимают.
 */

const linkBody = z.object({ password: z.string().min(1).max(200) });

/** Код живёт недолго: его успевают переслать боту, но не успевают потерять. */
const CODE_TTL_MINUTES = 15;

/**
 * Без похожих друг на друга символов: код диктуют вслух и набирают руками,
 * а «0/O» и «1/I/l» в такой ситуации путают гарантированно.
 */
const ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

function generateCode(): string {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  app.get("/telegram/status", { preHandler: requireTeam }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.id },
      select: { telegramChatId: true },
    });
    return reply.send({ available: canNotify, connected: Boolean(user?.telegramChatId) });
  });

  app.post(
    "/telegram/link-code",
    {
      preHandler: [requireTeam, requireCrmOrigin],
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      const parsed = linkBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Введите пароль" });

      if (!canNotify) {
        return reply.code(503).send({ error: "Бот не настроен на сервере" });
      }

      const owner = await prisma.user.findUnique({
        where: { id: request.user!.id },
        select: { passwordHash: true },
      });
      if (!owner || !(await verifyPassword(owner.passwordHash, parsed.data.password))) {
        return reply
          .code(403)
          .send({ error: "Неверный пароль", code: "password_invalid" });
      }

      // Уникальность кода обеспечена индексом; на 25^6 вариантов и трёх
      // пользователей повтор практически невозможен, но если он случится —
      // запрос просто повторят.
      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

      await prisma.user.update({
        where: { id: request.user!.id },
        data: { telegramLinkCode: code, telegramLinkExpiresAt: expiresAt },
      });

      return reply.send({ code, expiresAt: expiresAt.toISOString() });
    },
  );

  app.post("/telegram/unlink", { preHandler: requireTeam }, async (request, reply) => {
    const userId = request.user!.id;
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null, telegramLinkCode: null, telegramLinkExpiresAt: null },
    });
    await audit(request, {
      entity: "users",
      entityId: userId,
      action: "telegram_unlink",
      diff: { reason: "settings" },
    });
    return reply.code(204).send();
  });
}
