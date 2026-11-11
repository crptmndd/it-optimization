import { WITH_MEMBER } from "../auth/session.js";
import { memberNameOf, type Viewer } from "../crm/access.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { byPriority, findTaskRows, renderTaskList } from "./my-tasks.js";
import { isPrivateChat } from "./notifications.js";
import { trySendMessage, type Keyboard } from "./telegram.js";
import { startOfToday, startOfTomorrow, zonedNow } from "./zone.js";

/**
 * Личные напоминания о сроках: вечером каждому, кто подключил бота, — его задачи со
 * сроком сегодня (ещё не закрытые) и завтра. Утренняя сводка говорит о сегодняшнем, но
 * сотрудник видит её в общем чате среди чужого, а о завтрашнем сроке не говорит никто.
 * Вечер — потому что «завтра срок» полезно узнать накануне, пока есть время.
 *
 * Лично, а не в общий чат: это список одного человека. Нечего напоминать — молчим, как и
 * сводка: ежедневное «всё спокойно» приучает не читать бота.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const REMINDER_JOB = "deadline-reminders";

/**
 * После этого часа напоминание того же дня уже не шлём: сервер, перезапущенный ночью,
 * не должен будить людей вчерашними сроками. День отмечается как пройденный.
 */
const LATEST = "21:00";

/**
 * Сроки человека на сегодня и завтра. Отдельно от рассылки: тот же список собирает
 * «Назад» из открытой задачи. Нечего показать — `null`.
 */
export async function deadlinesList(
  viewer: Viewer,
): Promise<{ text: string; keyboard: Keyboard } | null> {
  const person = viewer.memberName;
  if (!person) return null;
  const today = startOfToday(env.TIMEZONE);
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  const dayAfter = startOfTomorrow(
    env.TIMEZONE,
    new Date(tomorrow.getTime() + 3_600_000),
  );

  const rows = await findTaskRows(viewer, {
    developers: { has: person },
    dueAt: { gte: today, lt: dayAfter },
  });
  if (rows.length === 0) return null;

  return renderTaskList(
    "⏰ <b>Сроки</b>",
    [
      {
        title: "Сегодня, до конца дня",
        tasks: rows.filter((row) => row.dueAt! < tomorrow).sort(byPriority),
        options: { due: false },
      },
      {
        title: "Завтра",
        tasks: rows.filter((row) => row.dueAt! >= tomorrow).sort(byPriority),
        options: { due: false },
      },
    ],
    "r",
  );
}

export async function sendDeadlineReminders(log: Log): Promise<number> {
  const users = await prisma.user.findMany({
    where: {
      disabledAt: null,
      telegramChatId: { not: null },
      role: { in: ["admin", "employee"] },
    },
    include: WITH_MEMBER,
  });

  let sent = 0;
  for (const user of users) {
    const chatId = user.telegramChatId;
    const person = memberNameOf(user);
    if (!chatId || !isPrivateChat(chatId) || !person) continue;

    const list = await deadlinesList({
      id: user.id,
      role: user.role,
      memberName: person,
    });
    if (!list) continue;

    const { text, keyboard } = list;
    try {
      if (await trySendMessage(chatId, text, log, 3, keyboard)) sent += 1;
    } catch (cause) {
      log.warn({ err: cause, chatId }, "напоминание о сроках не доставлено");
    }
  }
  return sent;
}

/** Как у сводки: отметка дня в `job_runs`, а не в памяти, иначе перезапуск слал бы снова. */
export async function runRemindersIfDue(log: Log): Promise<void> {
  const { date, time } = zonedNow(env.TIMEZONE);
  if (time < env.REMINDER_TIME) return;

  const previous = await prisma.jobRun.findUnique({ where: { job: REMINDER_JOB } });
  if (previous?.ranOn === date) return;
  await prisma.jobRun.upsert({
    where: { job: REMINDER_JOB },
    create: { job: REMINDER_JOB, ranOn: date },
    update: { ranOn: date },
  });

  if (time > LATEST) {
    log.info({ time }, "напоминания о сроках пропущены: слишком поздно");
    return;
  }
  const sent = await sendDeadlineReminders(log);
  if (sent > 0) log.info({ sent }, "напоминания о сроках разосланы");
}
