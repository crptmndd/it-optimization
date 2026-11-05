import type { Lead, TaskPriority } from "@prisma/client";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { escapeHtml, trySendMessage, type LinkButton } from "./telegram.js";
import { formatDate } from "./zone.js";

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

/** У групп идентификатор отрицательный, в них нельзя писать адресованное человеку. */
export function isPrivateChat(chatId: string): boolean {
  return /^\d+$/.test(chatId);
}

/** Один заблокировавший бота админ не должен оставить без сообщения остальных. */
async function sendPrivate(
  chatId: string,
  text: string,
  log: Log,
  button?: LinkButton,
): Promise<void> {
  try {
    await trySendMessage(chatId, text, log, 3, button);
  } catch (cause) {
    log.warn({ err: cause, chatId }, "личное сообщение не доставлено");
  }
}

/**
 * Лично каждому действующему админу, подключившему бота. Запасного пути в общий чат нет
 * намеренно: там сидят сотрудники, а в этих сообщениях деньги и контакты клиентов.
 */
export async function notifyAdmins(
  text: string,
  log: Log,
  button?: LinkButton,
): Promise<void> {
  if (!canNotify) return;

  const admins = await prisma.user.findMany({
    where: { role: "admin", disabledAt: null, telegramChatId: { not: null } },
    select: { telegramChatId: true },
  });
  const chats = admins.flatMap(({ telegramChatId: chatId }) =>
    chatId && isPrivateChat(chatId) ? [chatId] : [],
  );

  if (chats.length === 0) {
    log.warn({}, "ни один админ не подключил бота, сообщение не отправлено");
    return;
  }
  for (const chatId of chats) await sendPrivate(chatId, text, log, button);
}

/** Люди из списка с учёткой админа. Значение — их чат, если бот подключён. */
async function adminChatsOf(people: string[]): Promise<Map<string, string | null>> {
  const rows = await prisma.teamMember.findMany({
    where: { name: { in: people }, user: { role: "admin", disabledAt: null } },
    select: { name: true, user: { select: { telegramChatId: true } } },
  });
  return new Map(rows.map((row) => [row.name, row.user?.telegramChatId ?? null]));
}

/** Сообщение о новом лиде. Лиды закрыты для сотрудника, а в сообщении контакт человека. */
export async function notifyNewLead(lead: Lead, log: Log): Promise<void> {
  const lines = [
    "🆕 <b>Новый лид</b>",
    "",
    `<b>${escapeHtml(lead.name?.trim() || lead.contact)}</b>`,
  ];
  if (lead.name?.trim()) lines.push(escapeHtml(lead.contact));
  if (lead.message?.trim()) lines.push("", escapeHtml(lead.message.trim()));
  if (!lead.ownerId) lines.push("", "Никто не назначен.");

  await notifyAdmins(lines.join("\n"), log);
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
 * Нет ни того ни другого — остаётся имя: задачу всё равно увидят.
 */
export function mention(
  name: string,
  handle: string | null | undefined,
  telegramId: string | null | undefined,
): string {
  if (handle) return `@${escapeHtml(handle)}`;
  // У групп идентификатор отрицательный, упомянуть можно только человека.
  if (telegramId && isPrivateChat(telegramId)) {
    return `<a href="tg://user?id=${telegramId}">${escapeHtml(name)}</a>`;
  }
  return escapeHtml(name);
}

/** Как отметить каждого из этих людей: имя → готовая разметка. */
async function taskTags(people: string[]): Promise<Map<string, string>> {
  const members = await prisma.teamMember.findMany({
    where: { name: { in: people } },
    select: {
      name: true,
      telegramUsername: true,
      user: { select: { telegramChatId: true, disabledAt: true } },
    },
  });
  const byName = new Map(members.map((row) => [row.name, row]));
  return new Map(
    people.map((name) => {
      const member = byName.get(name);
      // Чат отключённой учётки не отмечаем: человек ушёл, а ссылка вела бы на него.
      const chat = member?.user?.disabledAt ? null : member?.user?.telegramChatId;
      return [name, mention(name, member?.telegramUsername, chat)];
    }),
  );
}

export interface TaskNotice {
  id: string;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueAt: Date | null;
  developers: string[];
  /** Есть у подзадачи: сообщение называет родителя, кнопка ведёт к нему. */
  parent?: { id: string; title: string } | null;
}

/** Длиннее в чате не читают: подробности лежат в карточке, до неё одна кнопка. */
const NOTE_LIMIT = 280;

function shorten(text: string): string {
  const clean = text.trim();
  if (clean.length <= NOTE_LIMIT) return clean;
  return `${clean.slice(0, NOTE_LIMIT).trimEnd()}…`;
}

/** Подпись в мужском роде, а не как в форме: здесь она стоит после слова «Приоритет». */
const PRIORITY_LINES: Record<TaskPriority, string> = {
  low: "🟢 Приоритет: Низкий",
  normal: "🟡 Приоритет: Обычный",
  important: "🟠 Приоритет: Высокий",
  high: "🔴 Приоритет: Срочно",
};

function assigneeLine(people: string[]): string {
  return `Исполнитель: ${people.length > 0 ? people.join(", ") : "не назначен"}`;
}

function dueLine(date: Date, timeZone: string): string {
  return `📅 Срок: ${formatDate(date, timeZone)}`;
}

/**
 * Один вид для чата и лички, для новой задачи и для назначенной. Название идёт первым:
 * на телефоне в уведомлении видно только начало, а человеку важнее, что за задача.
 * `people` — готовая разметка: в чате там отметки, в личке просто имена.
 */
export function taskMessage(input: {
  task: TaskNotice;
  note: string | null;
  people: string[];
  timeZone: string;
}): string {
  const { task, note, people, timeZone } = input;

  const lines = [`📌 <b>${escapeHtml(task.title)}</b>`];
  if (note?.trim()) lines.push(`💬 ${escapeHtml(shorten(note))}`);
  if (task.parent) lines.push(`🧩 В задаче: ${escapeHtml(task.parent.title)}`);

  lines.push("", assigneeLine(people), "", PRIORITY_LINES[task.priority]);
  if (task.dueAt) lines.push(dueLine(task.dueAt, timeZone));

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

/**
 * Админу лично, остальным тэгом в общем чате. Работу админа в чате не показываем, поэтому
 * задача только на админов туда не идёт, а в общей отмечены только сотрудники. Задача без
 * исполнителя остаётся в чате: там её кто-то возьмёт.
 */
/**
 * `teamChat: false` — галочка «Уведомление в общий чат» снята при постановке: задачу
 * обсудили лично, и тэг в чате только шумит. Выключает только чат: админу лично о его
 * задаче бот пишет по-прежнему, это его собственная работа, а не оповещение команды.
 */
export interface TaskNotifyOptions {
  teamChat?: boolean;
}

/**
 * Последняя заметка: при постановке она единственная, при назначении это то, что человек
 * первым увидит на карточке. `description` остаётся только у старой вкладки.
 */
async function taskNote(task: TaskNotice): Promise<string | null> {
  const note = await prisma.note.findFirst({
    where: { entity: "task", entityId: task.id },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  return note?.body ?? task.description;
}

async function notifyTask(
  task: TaskNotice,
  people: string[],
  log: Log,
  options: TaskNotifyOptions = {},
): Promise<void> {
  if (!canNotify) return;

  const admins = await adminChatsOf(people);
  const others = people.filter((name) => !admins.has(name));
  const note = await taskNote(task);
  // Своей карточки у подзадачи нет, открывается родитель.
  const button = taskButton(task.parent?.id ?? task.id, env.CRM_ORIGIN);

  const privateText = taskMessage({
    task,
    note,
    people: task.developers.map(escapeHtml),
    timeZone: env.TIMEZONE,
  });
  for (const [name, chatId] of admins) {
    if (!chatId || !isPrivateChat(chatId)) {
      log.warn({ name }, "админ не подключил бота, задача ему не отправлена");
      continue;
    }
    await sendPrivate(chatId, privateText, log, button);
  }

  // Запасного пути «всем лично», как у админов, нет намеренно: тэг имеет смысл только
  // там, где его видят все, а личное сообщение о чужой задаче никому не нужно.
  const chatId = env.TELEGRAM_TEAM_CHAT_ID;
  if (!chatId) return;
  if (options.teamChat === false) return;
  if (people.length > 0 && others.length === 0) return;

  // Задачу без исполнителя показывают всем, чтобы её кто-то взял. Подзадачу без него
  // никто не ждёт: это строка чек-листа внутри чужой карточки, а не работа без хозяина.
  if (task.parent && people.length === 0) return;

  // Исполнители названы все, а отмечены только те, кого надо разбудить: админу бот уже
  // написал лично, а прежних исполнителей правка задачи не касается.
  const tags = await taskTags(others);
  const text = taskMessage({
    task,
    note,
    people: task.developers.map((name) => tags.get(name) ?? escapeHtml(name)),
    timeZone: env.TIMEZONE,
  });

  await trySendMessage(chatId, text, log, 3, button);
}

/**
 * Задача уже сохранена, а телеграм может лежать или отвечать десятки секунд, поэтому
 * ответ API его не ждёт. `trySendMessage` бросает, когда бота выгнали из чата: это
 * ловится здесь же, иначе вышел бы необработанный отказ промиса и упал весь процесс.
 */
export function notifyTaskInBackground(
  task: TaskNotice,
  people: string[],
  log: Log,
  options: TaskNotifyOptions = {},
): void {
  void notifyTask(task, people, log, options).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о задаче не отправлено");
  });
}

export interface ProjectNotice {
  id: string;
  title: string;
  deadline: Date | null;
  developers: string[];
  client: { name: string } | null;
}

/** Тот же вид, что у задачи, только вместо важности клиент. */
export function projectMessage(project: ProjectNotice, timeZone: string): string {
  const lines = [`📁 <b>${escapeHtml(project.title)}</b>`, ""];
  if (project.client) lines.push(`Клиент: ${escapeHtml(project.client.name)}`);
  lines.push(assigneeLine(project.developers.map(escapeHtml)));
  if (project.deadline) lines.push("", dueLine(project.deadline, timeZone));
  return lines.join("\n");
}

function projectButton(id: string, origin: string | undefined): LinkButton | undefined {
  if (!origin?.startsWith("https://")) return undefined;
  return { text: "Открыть проект", url: `${origin}/#/projects?open=${id}` };
}

/** Новый проект видят все админы: в общий чат проекты не идут. */
export function notifyNewProjectInBackground(project: ProjectNotice, log: Log): void {
  const text = projectMessage(project, env.TIMEZONE);
  void notifyAdmins(text, log, projectButton(project.id, env.CRM_ORIGIN)).catch(
    (cause: unknown) => {
      log.warn({ err: cause }, "уведомление о проекте не отправлено");
    },
  );
}

async function notifyProjectAssigned(
  project: ProjectNotice,
  people: string[],
  log: Log,
): Promise<void> {
  if (!canNotify) return;

  const text = projectMessage(project, env.TIMEZONE);
  const button = projectButton(project.id, env.CRM_ORIGIN);
  for (const [, chatId] of await adminChatsOf(people)) {
    if (!chatId || !isPrivateChat(chatId)) continue;
    await sendPrivate(chatId, text, log, button);
  }
}

/** Админ, добавленный в уже заведённый проект. Сотрудников это не касается. */
export function notifyProjectAssignedInBackground(
  project: ProjectNotice,
  people: string[],
  log: Log,
): void {
  void notifyProjectAssigned(project, people, log).catch((cause: unknown) => {
    log.warn({ err: cause }, "уведомление о проекте не отправлено");
  });
}
