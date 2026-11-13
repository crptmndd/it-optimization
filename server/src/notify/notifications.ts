import type { Lead, TaskPriority } from "@prisma/client";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { isClosed } from "../crm/tasks/service.js";
import {
  escapeHtml,
  trySendMessage,
  type Keyboard,
  type LinkButton,
  type Markup,
} from "./telegram.js";
import { formatDate } from "./zone.js";

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

/** У групп идентификатор отрицательный, в них нельзя писать адресованное человеку. */
export function isPrivateChat(chatId: string): boolean {
  return /^\d+$/.test(chatId);
}

/** Один заблокировавший бота админ не должен оставить без сообщения остальных. */
export async function sendPrivate(
  chatId: string,
  text: string,
  log: Log,
  button?: Markup,
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

/**
 * Люди из списка с действующей учёткой: админ ли он и его личный чат, если бот подключён.
 * Человек без учётки сюда не попадает: писать ему лично некуда, остаётся тэг в чате.
 */
export async function accountChatsOf(
  people: string[],
): Promise<Map<string, { admin: boolean; chatId: string | null }>> {
  const rows = await prisma.teamMember.findMany({
    where: {
      name: { in: people },
      user: { role: { in: ["admin", "employee"] }, disabledAt: null },
    },
    select: { name: true, user: { select: { role: true, telegramChatId: true } } },
  });
  return new Map(
    rows.map((row) => [
      row.name,
      { admin: row.user?.role === "admin", chatId: row.user?.telegramChatId ?? null },
    ]),
  );
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
  /** Решает, какие кнопки под сообщением: закрытой задаче нечего «взять в работу». */
  status: string;
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

interface KeyboardTask {
  id: string;
  status: string;
  parent?: { id: string } | null;
  /** Убрана в архив руками: «Проверено» уже нажали, второй раз кнопка не нужна. */
  archivedAt?: Date | null;
  /** Сколько файлов у задачи (у подзадачи — у родителя): есть — есть и «🗂 Файлы». */
  files?: number;
}

/**
 * Действия с задачей без открытия CRM: закрыть, взять в работу, сменить срок, прикрепить
 * файл, посмотреть приложенные. Нажимает кто угодно из чата, а право проверяется при нажатии тем же правилом, что
 * и правка в CRM (`notify/task-actions.ts`). Закрытой задаче вместо «Готово» —
 * «Вернуть в работу»: случайное нажатие должно отменяться там же, где сделано.
 *
 * Срок и файл просят ответа текстом или файлом (`notify/pending.ts`), поэтому это не
 * мгновенные кнопки: «На завтра» умел только одно, а срок бывает любым.
 */
export function taskActionRows(task: KeyboardTask): Keyboard {
  const closed = isClosed(task.status);
  const status = closed
    ? { text: "↩️ Вернуть в работу", callback_data: `s:back:${task.id}` }
    : { text: "✅ Готово", callback_data: `s:done:${task.id}` };
  // Смотреть файлы — не правка, поэтому кнопка есть и у подзадачи: её файлы лежат у
  // родителя, и строка «📎 Файлов» под ней о них.
  const show = task.files
    ? { text: `🗂 Файлы (${task.files})`, callback_data: `s:show:${task.id}` }
    : null;
  // У подзадачи в CRM только «сделано» и «не сделано», срока и файлов у неё не видно:
  // ей одна кнопка, иначе нажатие меняло бы то, чего в карточке нет.
  if (task.parent) return [show ? [status, show] : [status]];

  const first = [status];
  if (!closed && task.status !== "in_progress") {
    first.push({ text: "▶️ В работу", callback_data: `s:work:${task.id}` });
  }
  // Сделанную задачу проверяют и убирают с доски одним нажатием. Отменённую проверять
  // нечего, а уже убранную — незачем.
  if (task.status === "done" && !task.archivedAt) {
    first.push({ text: "☑️ Проверено", callback_data: `s:chk:${task.id}` });
  }
  const file = { text: "📎 Прикрепить файл", callback_data: `s:file:${task.id}` };
  const edit = { text: "✏️ Редактировать", callback_data: `e:menu:${task.id}` };
  // «Файлы» встают рядом с одной из кнопок, а не третьей в ряд: на телефоне три кнопки
  // в ряду обрезают подписи.
  if (closed) return show ? [first, [file, show], [edit]] : [first, [file, edit]];
  return [
    first,
    [{ text: "📅 Изменить срок", callback_data: `s:due:${task.id}` }, file],
    show ? [edit, show] : [edit],
  ];
}

/** Сколько файлов у задачи. Файлы подзадачи лежат у родителя, поэтому `taskId` — его. */
export function countFiles(taskId: string): Promise<number> {
  return prisma.taskAttachment.count({ where: { taskId } });
}

/** «📎 Файлов: 3» под задачей — чтобы было видно, что скриншот доехал. */
export function filesLine(count: number): string | null {
  return count > 0 ? `📎 Файлов: ${count}` : null;
}

/** Действия и ссылка в карточку CRM последним рядом. */
export function taskKeyboard(task: KeyboardTask): Keyboard {
  const rows = taskActionRows(task);
  // Своей карточки у подзадачи нет, открывается родитель.
  const link = taskButton(task.parent?.id ?? task.id, env.CRM_ORIGIN);
  if (link) rows.push([link]);
  return rows;
}

/**
 * Каждому, на кого поставили задачу, — лично, если он подключил бота, и админу, и
 * сотруднику: тэг в общем чате теряется среди чужих сообщений, а личное видно сразу.
 * Сотрудники вдобавок отмечены в общем чате, как раньше. Работу админа в чате не
 * показываем, поэтому задача только на админов туда не идёт. Задача без исполнителя
 * остаётся в чате: там её кто-то возьмёт.
 *
 * `teamChat: false` — галочка «Уведомление в общий чат» снята при постановке: задачу
 * обсудили лично, и тэг в чате только шумит. Выключает только чат: лично бот пишет
 * по-прежнему, это собственная работа человека, а не оповещение команды.
 *
 * `skip` — кто поставил задачу. Лично ему не пишем: он её только что видел. Тэг в общем
 * чате остаётся как был.
 */
export interface TaskNotifyOptions {
  teamChat?: boolean;
  skip?: string | null;
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

export async function notifyTask(
  task: TaskNotice,
  people: string[],
  log: Log,
  options: TaskNotifyOptions = {},
): Promise<void> {
  if (!canNotify) return;

  const accounts = await accountChatsOf(people);
  const others = people.filter((name) => !accounts.get(name)?.admin);
  const note = await taskNote(task);
  const files = await countFiles(task.parent?.id ?? task.id);
  const button = taskKeyboard({ ...task, files });
  // Скриншоты к задаче чаще всего и есть суть поручения: исполнитель должен видеть, что
  // они есть, ещё до того, как откроет задачу.
  const withFiles = (text: string) =>
    files > 0
      ? `${text}
${filesLine(files)}`
      : text;

  const privateText = withFiles(
    taskMessage({
      task,
      note,
      people: task.developers.map(escapeHtml),
      timeZone: env.TIMEZONE,
    }),
  );
  for (const [name, account] of accounts) {
    if (name === options.skip) continue;
    if (!account.chatId || !isPrivateChat(account.chatId)) {
      // Админу больше ничего не придёт: в общий чат его работа не идёт. Сотрудника
      // разбудит тэг в чате, поэтому о нём не пишем.
      if (account.admin) {
        log.warn({ name }, "админ не подключил бота, задача ему не отправлена");
      }
      continue;
    }
    await sendPrivate(account.chatId, privateText, log, button);
  }

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
  const text = withFiles(
    taskMessage({
      task,
      note,
      people: task.developers.map((name) => tags.get(name) ?? escapeHtml(name)),
      timeZone: env.TIMEZONE,
    }),
  );

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

/** Кто сделал правку — для подписи в сообщении: имя из команды, иначе из учётки. */
export function actorName(user: {
  memberName: string | null;
  name?: string | null;
  email?: string;
}): string {
  return user.memberName ?? user.name ?? user.email ?? "кто-то из команды";
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
  // Проект — только админам: в его сообщении клиент, а деньги рядом.
  for (const [, account] of await accountChatsOf(people)) {
    if (!account.admin || !account.chatId || !isPrivateChat(account.chatId)) continue;
    await sendPrivate(account.chatId, text, log, button);
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
