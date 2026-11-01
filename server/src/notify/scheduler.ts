import { runMonthlyDocumentsIfDue } from "../crm/projects/monthly-documents.js";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { sendTeamDigest } from "./digest.js";
import { zonedNow } from "./zone.js";

/**
 * Планировщик. Отдельного cron-пакета не берём: одна проверка в минуту решает
 * задачу целиком.
 *
 * Живёт вне бота, потому что счета от бота не зависят: без токена телеграма
 * автодокументы всё равно создаются, молчит только сообщение о них.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const DIGEST_JOB = "daily-digest";

/**
 * Условие «время наступило и сегодня ещё не слали» вместо точного совпадения
 * минуты — чтобы перезапуск сервиса в 08:59 не съедал дайджест этого дня.
 * Отметка о рассылке лежит в базе, а не в памяти: иначе каждый перезапуск днём
 * выглядел бы как «сегодня ещё не рассылали».
 */
async function runDigestIfDue(log: Log): Promise<void> {
  const { date, time } = zonedNow(env.TIMEZONE);
  if (time < env.DIGEST_TIME) return;

  const previous = await prisma.jobRun.findUnique({ where: { job: DIGEST_JOB } });
  if (previous?.ranOn === date) return;

  // Отметку ставим до рассылки, а не после: рассылка идёт по одному сообщению
  // на человека и может занять дольше минуты, а следующий тик за это время
  // успел бы начать её заново.
  await prisma.jobRun.upsert({
    where: { job: DIGEST_JOB },
    create: { job: DIGEST_JOB, ranOn: date },
    update: { ranOn: date },
  });

  await sendTeamDigest(log);
}

export function startScheduler(log: Log): () => void {
  let running = false;

  async function tick(): Promise<void> {
    // Запуск не должен наезжать на предыдущий: рассылка бывает дольше минуты.
    if (running) return;
    running = true;
    try {
      // Счета раньше дайджеста: иначе в 09:00 бот назвал бы новый месяц
      // невыставленным.
      await runMonthlyDocumentsIfDue(log).catch((cause: unknown) => {
        log.error({ err: cause }, "автодокументы не созданы");
      });
      if (canNotify) {
        await runDigestIfDue(log).catch((cause: unknown) => {
          log.error({ err: cause }, "рассылка дайджеста не удалась");
        });
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), 60_000);
  timer.unref();
  // Сразу после старта, а не через минуту: это и есть догон после простоя.
  void tick();

  return () => clearInterval(timer);
}
