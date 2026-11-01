import { buildApp } from "./app.js";
import { purgeDeleted } from "./crm/trash/purge.js";
import { purgeExpiredSessions } from "./auth/session.js";
import { prisma } from "./db.js";
import { canNotify, canPublish, env } from "./env.js";
import { startBot } from "./notify/bot.js";
import { startScheduler } from "./notify/scheduler.js";

const app = await buildApp();

if (!canPublish) {
  app.log.warn(
    "GITHUB_TOKEN не задан: правки сохраняются в базу, но публикация на сайт отключена.",
  );
}

// Бот необязателен: без токена CRM работает полностью, просто молча.
const stopBot = canNotify
  ? startBot(app.log)
  : (app.log.warn("TELEGRAM_BOT_TOKEN не задан: напоминания отключены."),
    async () => {});

// Раз в сутки подчищаем истёкшие сессии и корзину — иначе таблицы растут вечно.
const cleanup = setInterval(
  () => {
    purgeExpiredSessions()
      .then((count) => count && app.log.info({ count }, "удалены истёкшие сессии"))
      .catch((cause: unknown) => app.log.error({ err: cause }, "очистка сессий не удалась"));
    purgeDeleted()
      .then((count) => count && app.log.info({ count }, "корзина очищена"))
      .catch((cause: unknown) => app.log.error({ err: cause }, "очистка корзины не удалась"));
  },
  24 * 60 * 60 * 1000,
);
cleanup.unref();

let stopScheduler = () => {};

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "остановка");
  clearInterval(cleanup);
  stopScheduler();
  await stopBot();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  stopScheduler = startScheduler(app.log);
} catch (cause) {
  app.log.error({ cause }, "не удалось запустить сервер");
  process.exit(1);
}
