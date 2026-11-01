import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPassword } from "./password.js";
import { createSession, destroySession, resolveUser, toUserDto } from "./session.js";
import { issueLoginTicket } from "./two-factor.js";

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/login",
    {
      config: {
        // Перебор паролей должен упираться в лимит, а не в терпение.
        rateLimit: { max: 10, timeWindow: "5 minutes" },
      },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Укажи почту и пароль" });
      }

      const { email, password } = parsed.data;
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
      });

      // Одинаковый ответ на «нет пользователя» и «неверный пароль»: иначе форма
      // превращается в способ узнать, какие адреса заведены.
      const ok = user && !user.disabledAt && (await verifyPassword(user.passwordHash, password));
      if (!user || !ok) {
        request.log.warn({ email }, "неудачная попытка входа");
        return reply.code(401).send({ error: "Неверная почта или пароль" });
      }

      // Условие только в признаке: ключ сюда не входит намеренно. Без VAULT_KEY вход
      // не упрощается, а закрывается: TOTP даёт 503, работают коды восстановления.
      if (user.totpEnabledAt) {
        const ticket = await issueLoginTicket(user.id, request.ip);
        return reply.send({ twoFactorRequired: true, ...ticket });
      }

      await createSession(reply, user, request);
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return reply.send({ user: toUserDto(user) });
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    await destroySession(request, reply);
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await resolveUser(request);
    if (!user) return reply.code(401).send({ error: "Не авторизован" });
    return reply.send({ user: toUserDto(user) });
  });
}
