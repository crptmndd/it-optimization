import type { Lead } from "@prisma/client";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { escapeHtml, trySendMessage, type LinkButton } from "./telegram.js";
import { daysOverdue, daysUntil, formatDayLong } from "./zone.js";

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

/**
 * Сообщение о новом лиде. Уходит в общий чат, если он задан, иначе — админам, которые
 * подключили бота. Второй путь важен: заводить группу ради троих необязательно. Только
 * админам, потому что лиды закрыты для сотрудника, а в сообщении контакт человека.
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
    where: { role: "admin", disabledAt: null, telegramChatId: { not: null } },
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

async function taskTags(people: string[]): Promise<string[]> {
  const unique = [...new Set(people)];
  const members = await prisma.teamMember.findMany({
    where: { name: { in: unique } },
    select: {
      name: true,
      telegramUsername: true,
      user: { select: { telegramChatId: true, disabledAt: true } },
    },
  });
  const byName = new Map(members.map((row) => [row.name, row]));
  return unique.map((name) => {
    const member = byName.get(name);
    // Чат отключённой учётки не отмечаем: человек ушёл, а ссылка вела бы на него.
    const chat = member?.user?.disabledAt ? null : member?.user?.telegramChatId;
    return mention(name, member?.telegramUsername, chat);
  });
}

/** Кто поставил задачу: подпись нужна по имени учётки, сравнение — по человеку. */
export interface TaskActor {
  name: string | null;
  memberName: string | null;
}

export interface TaskNotice {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueAt: Date | null;
  project: { title: string } | null;
  /** Есть у подзадачи: сообщение называет родителя, кнопка ведёт к нему. */
  parent?: { id: string; title: string } | null;
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
  const noun = task.parent ? "подзадача" : "задача";
  const what =
    kind === "assigned"
      ? urgent
        ? `назначена срочная ${noun}`
        : `назначена ${noun}`
      : urgent
        ? `новая срочная ${noun}`
        : `новая ${noun}`;

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
  if (task.parent) facts.push(`🧩 В задаче: ${escapeHtml(task.parent.title)}`);
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
export function taskButton(
  id: string,
  origin: string | undefined,
): LinkButton | undefined {
  if (!origin?.startsWith("https://")) return undefined;
  return { text: "Открыть задачу", url: `${origin}/#/tasks?open=${id}` };
}

async function notifyTask(
  task: TaskNotice,
  people: string[],
  kind: "created" | "assigned",
  actor: TaskActor,
  log: Log,
): Promise<void> {
  // Запасного пути «всем лично», как у лидов, нет намеренно: тэг имеет смысл только
  // там, где его видят все, а личное сообщение о чужой задаче никому не нужно.
  const chatId = env.TELEGRAM_TEAM_CHAT_ID;
  if (!canNotify || !chatId) return;

  // Задачу без исполнителя показывают всем, чтобы её кто-то взял. Подзадачу без него
  // никто не ждёт: это строка чек-листа внутри чужой карточки, а не работа без хозяина.
  if (task.parent && people.length === 0) return;

  const text = taskMessage({
    task,
    tags: await taskTags(people),
    kind,
    // Поставил сам себе — подпись ничего не добавляет.
    actor: actor.memberName && people.includes(actor.memberName) ? null : actor.name,
    timeZone: env.TIMEZONE,
  });

  // Своей карточки у подзадачи нет, открывается родитель.
  const target = task.parent?.id ?? task.id;
  await trySendMessage(chatId, text, log, 3, taskButton(target, env.CRM_ORIGIN));
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
  actor: TaskActor,
  log: Log,
): void {
  void notifyTask(task, people, kind, actor, log).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о задаче не отправлено");
  });
}
