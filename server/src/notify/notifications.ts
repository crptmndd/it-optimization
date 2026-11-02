import type { Lead } from "@prisma/client";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { escapeHtml, trySendMessage, type LinkButton } from "./telegram.js";
import { daysOverdue, daysUntil, formatDayLong } from "./zone.js";

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
 * Как отметить человека. Ник даёт настоящее упоминание, и уведомление придёт, даже
 * если чат приглушён. Ника нет, но человек подключил бота: телеграм позволяет
 * упомянуть по идентификатору, личный чат с ботом и есть идентификатор человека.
 * Нет ни того ни другого — остаётся жирное имя: задачу всё равно увидят.
 */
export function mention(
  name: string,
  handle: string | null | undefined,
  telegramId: string | null | undefined,
): string {
  if (handle) return `@${escapeHtml(handle)}`;
  // У групп идентификатор отрицательный, упомянуть можно только человека.
  if (telegramId && /^\d+$/.test(telegramId)) {
    return `<a href="tg://user?id=${telegramId}">${escapeHtml(name)}</a>`;
  }
  return `<b>${escapeHtml(name)}</b>`;
}

/** Первое слово: в учётке бывает «Вадим Валеев», а исполнитель значится «Вадим». */
function firstWord(value: string | null): string {
  return value?.trim().split(/\s+/)[0] ?? "";
}

async function taskTags(people: string[]): Promise<string[]> {
  const unique = [...new Set(people)];
  const [members, linked] = await Promise.all([
    prisma.teamMember.findMany({ where: { name: { in: unique } } }),
    prisma.user.findMany({
      where: { disabledAt: null, telegramChatId: { not: null } },
      select: { name: true, telegramChatId: true },
    }),
  ]);
  const handles = new Map(members.map((row) => [row.name, row.telegramUsername]));
  const chats = new Map(linked.map((row) => [firstWord(row.name), row.telegramChatId]));
  return unique.map((name) => mention(name, handles.get(name), chats.get(name)));
}

export interface TaskNotice {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueAt: Date | null;
  project: { title: string } | null;
}

/** Длиннее в чате не читают: подробности лежат в карточке, до неё одна кнопка. */
const DESCRIPTION_LIMIT = 280;

function shorten(text: string): string {
  const clean = text.trim();
  if (clean.length <= DESCRIPTION_LIMIT) return clean;
  return `${clean.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`;
}

/** Срок словами: дата нужна, но решает «завтра» и «просрочено». */
export function dueLine(dueAt: Date, timeZone: string, now = new Date()): string {
  const date = formatDayLong(dueAt, timeZone);
  const overdue = daysOverdue(dueAt, timeZone, now);
  if (overdue > 0) return `${date} — уже просрочено`;
  const left = daysUntil(dueAt, timeZone, now);
  if (left === 0) return `${date} — сегодня`;
  if (left === 1) return `${date} — завтра`;
  return date;
}

export function taskMessage(input: {
  task: TaskNotice;
  tags: string[];
  kind: "created" | "assigned";
  actor: string | null;
  timeZone: string;
  now?: Date;
}): string {
  const { task, tags, kind, actor, timeZone, now } = input;
  const urgent = task.priority === "high";
  const icon = urgent ? "🔥" : kind === "created" ? "📌" : "👋";
  const what =
    kind === "assigned"
      ? urgent
        ? "назначена срочная задача"
        : "назначена задача"
      : urgent
        ? "новая срочная задача"
        : "новая задача";

  // Тэг в первой строке: это единственное, что видно в уведомлении на телефоне.
  const headline =
    tags.length > 0
      ? `${icon} ${tags.join(" ")}, ${what}`
      : `${icon} ${what[0]?.toUpperCase()}${what.slice(1)}, исполнителя пока нет`;

  const lines = [headline, "", `<b>${escapeHtml(task.title)}</b>`];
  if (task.description?.trim()) {
    lines.push(`<blockquote>${escapeHtml(shorten(task.description))}</blockquote>`);
  }

  const facts: string[] = [];
  if (task.project) facts.push(`📁 ${escapeHtml(task.project.title)}`);
  if (task.dueAt) facts.push(`⏰ ${dueLine(task.dueAt, timeZone, now)}`);
  if (actor) facts.push(`👤 От: ${escapeHtml(actor)}`);
  if (facts.length > 0) lines.push("", ...facts);

  return lines.join("\n");
}

/**
 * Кнопка в карточку. Телеграм принимает в ней только настоящий адрес и отвергает всё
 * сообщение за localhost, поэтому без боевого https кнопки просто нет.
 */
export function taskButton(id: string, origin: string | undefined): LinkButton | undefined {
  if (!origin?.startsWith("https://")) return undefined;
  return { text: "Открыть задачу", url: `${origin}/#/tasks?open=${id}` };
}

async function notifyTask(
  task: TaskNotice,
  people: string[],
  kind: "created" | "assigned",
  actor: string | null,
  log: Log,
): Promise<void> {
  // Запасного пути «всем лично», как у лидов, нет намеренно: тэг имеет смысл только
  // там, где его видят все, а личное сообщение о чужой задаче никому не нужно.
  const chatId = env.TELEGRAM_TEAM_CHAT_ID;
  if (!canNotify || !chatId) return;

  const text = taskMessage({
    task,
    tags: await taskTags(people),
    kind,
    // Поставил сам себе — подпись ничего не добавляет.
    actor: actor && !people.includes(firstWord(actor)) ? actor : null,
    timeZone: env.TIMEZONE,
  });

  await trySendMessage(chatId, text, log, 3, taskButton(task.id, env.CRM_ORIGIN));
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
  actor: string | null,
  log: Log,
): void {
  void notifyTask(task, people, kind, actor, log).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о задаче не отправлено");
  });
}
