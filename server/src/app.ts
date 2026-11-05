import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { authRoutes } from "./auth/routes.js";
import { twoFactorRoutes } from "./auth/two-factor.js";
import { caseRoutes } from "./cases/routes.js";
import { leadRoutes } from "./crm/leads/routes.js";
import { teamRoutes } from "./crm/team.js";
import { env, isProduction } from "./env.js";
import { clientRoutes } from "./crm/clients/routes.js";
import { credentialRoutes } from "./crm/credentials/routes.js";
import { projectRoutes } from "./crm/projects/routes.js";
import { taskRoutes } from "./crm/tasks/routes.js";
import { columnRoutes } from "./crm/columns/routes.js";
import { todayRoutes } from "./crm/today-routes.js";
import { searchRoutes } from "./crm/search/routes.js";
import { trashRoutes } from "./crm/trash/routes.js";
import { vaultRoutes } from "./crm/vault/routes.js";
import { telegramRoutes } from "./notify/routes.js";
import { postRoutes } from "./posts/routes.js";
import { serviceCatalogRoutes } from "./services/routes.js";
import { blogPublishRoutes, publishRoutes } from "./publish/routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProduction
      ? { level: "info" }
      : { level: "info", transport: { target: "pino-pretty" } },
    trustProxy: isProduction,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Куки ходят между поддоменами (сайт, CRM и API), поэтому нужен явный
  // список origin'ов — с credentials браузер не примет «*».
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    // PATCH обязателен: правки в CRM идут им. Метод, которого нет в этом
    // списке, браузер блокирует на предварительном запросе — и до сервера
    // ничего не доходит, а в интерфейсе это выглядит как «сервер не отвечает».
    // Проверить можно только из браузера: curl CORS не соблюдает.
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // Обязательно до регистрации маршрутов: дочерние контексты наследуют
  // обработчик в момент своей регистрации, и поставленный позже до них не
  // дойдёт — наружу полетят внутренние тексты ошибок (пути, адрес базы).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ error }, "необработанная ошибка");
    const status = error.statusCode ?? 500;
    // Наружу — только безопасный текст: детали остаются в логах.
    reply.code(status).send({
      error: status < 500 ? error.message : "Внутренняя ошибка сервера",
    });
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(twoFactorRoutes);
  await app.register(caseRoutes);
  await app.register(publishRoutes);
  await app.register(postRoutes);
  await app.register(blogPublishRoutes);
  await app.register(serviceCatalogRoutes);
  await app.register(clientRoutes);
  await app.register(credentialRoutes);
  await app.register(projectRoutes);
  await app.register(taskRoutes);
  await app.register(columnRoutes);
  await app.register(todayRoutes);
  await app.register(searchRoutes);
  await app.register(trashRoutes);
  await app.register(vaultRoutes);
  await app.register(telegramRoutes);

  // CRM. Живёт в том же процессе и за той же авторизацией, что и контент сайта:
  // отдельный сервис потребовал бы второй копии сессий, ролей и журнала.
  await app.register(teamRoutes);
  await app.register(leadRoutes);

  return app;
}
