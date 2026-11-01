import type { Lead } from "@prisma/client";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { escapeHtml, trySendMessage } from "./telegram.js";
import { formatDay } from "./zone.js";

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Сообщение о новом лиде. Уходит в общий чат, если он задан, иначе — всем, кто
 * подключил бота. Второй путь важен: заводить группу ради троих необязательно,
 * а знать о новом обращении должны все.
 */
export async function notifyNewLead(lead: Lead, log: Log): Promise<void> {
  if (!canNotify) return;

  const lines = [
    "🆕 <b>Новый лид</b>",
    "",
    `<b>${escapeHtml(lead.name?.trim() || lead.contact)}</b>`,
  ];
  if (lead.name?.trim()) lines.push(escapeHtml(lead.contact));
  if (lead.message?.trim()) lines.push("", escapeHtml(lead.message.trim()));
  if (!lead.ownerId) lines.push("", "Никто не назначен.");

  const text = lines.join("\n");

  if (env.TELEGRAM_TEAM_CHAT_ID) {
    await trySendMessage(env.TELEGRAM_TEAM_CHAT_ID, text, log);
    return;
  }

  const users = await prisma.user.findMany({
    where: { disabledAt: null, telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });

  for (const user of users) {
    if (user.telegramChatId) await trySendMessage(user.telegramChatId, text, log);
  }
}

/**
 * Уведомление не должно ни задерживать ответ API, ни тем более его ронять:
 * лид уже сохранён, а телеграм может лежать.
 */
export function notifyNewLeadInBackground(lead: Lead, log: Log): void {
  void notifyNewLead(lead, log).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о новом лиде не отправлено");
  });
}

/**
 * Ник даёт настоящее упоминание, и человеку приходит уведомление, даже если чат у
 * него приглушён. Ника нет — остаётся жирное имя: задачу всё равно увидят, а строки в
 * `team_members` у человека может и не быть.
 */
async function taskTags(people: string[]): Promise<string> {
  const rows = await prisma.teamMember.findMany({ where: { name: { in: people } } });
  const handles = new Map(rows.map((row) => [row.name, row.telegramUsername]));
  return [...new Set(people)]
    .map((name) => {
      const handle = handles.get(name);
      return handle ? `@${escapeHtml(handle)}` : `<b>${escapeHtml(name)}</b>`;
    })
    .join(" ");
}

interface TaskNotice {
  title: string;
  dueAt: Date | null;
  project: { title: string } | null;
}

async function notifyTask(
  task: TaskNotice,
  people: string[],
  kind: "created" | "assigned",
  log: Log,
): Promise<void> {
  // Запасного пути «всем лично», как у лидов, нет намеренно: тэг имеет смысл только
  // там, где его видят все, а личное сообщение о чужой задаче никому не нужно.
  const chatId = env.TELEGRAM_TEAM_CHAT_ID;
  if (!canNotify || !chatId) return;

  const lines = [
    kind === "created" ? "🆕 <b>Новая задача</b>" : "👤 <b>Назначена задача</b>",
    `<b>${escapeHtml(task.title)}</b>`,
  ];
  if (task.project) lines.push(`Проект: ${escapeHtml(task.project.title)}`);
  if (task.dueAt) lines.push(`Срок: ${formatDay(task.dueAt, env.TIMEZONE)}`);
  if (people.length > 0) lines.push(await taskTags(people));

  await trySendMessage(chatId, lines.join("\n"), log);
}

/**
 * Задача уже сохранена, а телеграм может лежать или отвечать десятки секунд, поэтому
 * ответ API его не ждёт. `trySendMessage` бросает, когда бота выгнали из чата: это
 * ловится здесь же, иначе вышел бы необработанный отказ промиса и упал весь процесс.
 */
export function notifyTaskInBackground(
  task: TaskNotice,
  people: string[],
  kind: "created" | "assigned",
  log: Log,
): void {
  void notifyTask(task, people, kind, log).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о задаче не отправлено");
  });
}
