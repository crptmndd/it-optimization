import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { resolveAuth, type AuthContext, type AuthenticatedUser } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    /** Сессия запроса: окно подтверждения 2FA живёт в её строке. */
    authSession?: AuthContext["session"];
  }
}

/**
 * preHandler для всего, что меняет контент. Кладёт пользователя в request,
 * чтобы обработчики не ходили в базу второй раз.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = await resolveAuth(request);
  if (!auth) {
    await reply.code(401).send({ error: "Не авторизован" });
    return;
  }
  request.user = auth.user;
  request.authSession = auth.session;
}

/**
 * Доступ по ролям.
 *
 * Проверка обязана стоять здесь, а не в интерфейсе: спрятанный пункт меню
 * защищает от случайного клика, но не от человека, который откроет консоль
 * браузера и позовёт маршрут напрямую. Роль только тогда что-то значит, когда
 * сервер сам отказывает. Читается на каждом запросе, поэтому понижение действует
 * сразу, а не со следующего входа.
 */
export function requireRole(
  ...allowed: AuthenticatedUser["role"][]
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function guard(request, reply) {
    const auth = await resolveAuth(request);
    if (!auth) {
      await reply.code(401).send({ error: "Не авторизован" });
      return;
    }
    if (!allowed.includes(auth.user.role)) {
      await reply.code(403).send({ error: "Недостаточно прав" });
      return;
    }
    request.user = auth.user;
    request.authSession = auth.session;
  };
}

/**
 * Вся команда. Что именно видит сотрудник внутри таких маршрутов, решает
 * `crm/access.ts`: роль здесь пускает к разделу, а не к записям.
 */
export const requireTeam = requireRole("admin", "employee");

/** Деньги, клиенты, доступы, корзина, панель сайта, учётки и лиды. */
export const requireAdmin = requireRole("admin");

/**
 * Пароли и привязка телеграма — только со страницы CRM. Кука общая на домен, а сайт с
 * панелью тоже стоит в WEB_ORIGIN: раньше скрипт на сайте получил бы шифротекст, теперь
 * пароль расшифровывает сервер, и хранимый XSS на сайте дотянулся бы до паролей
 * человека с открытым окном. От `curl` с украденной кукой это не защищает и не должно:
 * для неё есть код и пароль.
 */
export async function requireCrmOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!env.CRM_ORIGIN || request.headers.origin === env.CRM_ORIGIN) return;
  await reply
    .code(403)
    .send({ error: "Это действие доступно только из CRM", code: "origin_forbidden" });
}
