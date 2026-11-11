import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { auditAs } from "../../audit.js";
import { WITH_MEMBER } from "../../auth/session.js";
import {
  isAdmin,
  liveTask,
  memberNameOf,
  taskScope,
  type Viewer,
} from "../../crm/access.js";
import { assertDevelopers } from "../../crm/people.js";
import { TASK_RELATIONS } from "../../crm/tasks/dto.js";
import { isClosed, reachableTask } from "../../crm/tasks/service.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { notifyTask, taskButton, taskMessage } from "../notifications.js";
import {
  answerCallback,
  editMessage,
  escapeHtml,
  type InlineButton,
  type Keyboard,
  type TgCallbackQuery,
} from "../telegram.js";
import { attachmentsLine } from "./files.js";
import { loadPeople } from "./parse.js";

/**
 * Карточка задачи, поставленной из сообщения. Она не хранит состояния: каждое нажатие
 * перечитывает задачу из базы и рисует карточку заново, поэтому правка в CRM между
 * нажатиями не расходится с тем, что видно в телеграме, а перезапуск сервера кнопок не
 * ломает. Идентификатор задачи едет в самих кнопках.
 */

export interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const CARD_TASK = {
  project: { select: { title: true } },
  parent: { select: { id: true, title: true } },
  subtasks: {
    where: { deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { title: true, status: true, developers: true },
  },
} satisfies Prisma.TaskInclude;

type CardTask = Prisma.TaskGetPayload<{ include: typeof CARD_TASK }>;

export type CardView = "main" | "people";

export function loadCardTask(id: string): Promise<CardTask | null> {
  return prisma.task.findUnique({ where: { id }, include: CARD_TASK });
}

/** Короткий ключ человека в кнопке: имя целиком не влезло бы в 64 байта данных кнопки. */
function personKey(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 8);
}

function rows<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Задача, о которой сообщение бота: карточка, уведомление или карточка из `/tasks`. Берётся
 * из данных кнопок. Список `/tasks` (кнопки `o:`) — не про одну задачу, он не подходит.
 */
export function cardTaskId(
  markup:
    | {
        inline_keyboard?: { callback_data?: string }[][];
      }
    | undefined,
): string | null {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      const data = button.callback_data;
      if (!data || data.startsWith("o:")) continue;
      const id = data.split(":").find((part) => UUID.test(part));
      if (id) return id;
    }
  }
  return null;
}

/** Последняя заметка, как в уведомлении: при постановке из сообщения она единственная. */
async function noteOf(task: CardTask): Promise<string | null> {
  const note = await prisma.note.findFirst({
    where: { entity: "task", entityId: task.id },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  return note?.body ?? task.description;
}

export async function renderCard(
  task: CardTask,
  view: CardView,
  extras: string[] = [],
): Promise<{ text: string; keyboard: Keyboard }> {
  if (task.deletedAt) {
    return {
      text: `❌ Отменено: <s>${escapeHtml(task.title)}</s>`,
      keyboard: [[{ text: "Вернуть", callback_data: `r:${task.id}` }]],
    };
  }

  const lines = [
    task.parent ? "✅ Добавил подзадачу" : "✅ Поставил задачу",
    "",
    taskMessage({
      task,
      note: await noteOf(task),
      people: task.developers.map(escapeHtml),
      timeZone: env.TIMEZONE,
    }),
  ];
  // В уведомлении проекта нет по шаблону владельца, а здесь он нужен: автор проверяет,
  // куда модель положила задачу.
  if (task.project) lines.push(`📁 Проект: ${escapeHtml(task.project.title)}`);
  if (task.subtasks.length > 0) {
    lines.push("", "Подзадачи:");
    for (const sub of task.subtasks) {
      const who =
        sub.developers.length > 0 ? ` — ${escapeHtml(sub.developers.join(", "))}` : "";
      lines.push(`${sub.status === "done" ? "☑️" : "▫️"} ${escapeHtml(sub.title)}${who}`);
    }
  }
  const files = await attachmentsLine(task.parentId ?? task.id);
  if (files) lines.push(files);
  if (extras.length > 0) lines.push("", ...extras);

  const cancel: InlineButton = { text: "↩️ Отменить", callback_data: `c:${task.id}` };

  if (view === "people") {
    // Отключённый человек, который уже стоит на задаче, тоже в списке: его можно снять.
    const names = [
      ...new Set([
        ...(await loadPeople()).map((person) => person.name),
        ...task.developers,
      ]),
    ];
    const people = names.map((name) => ({
      text: `${task.developers.includes(name) ? "✅ " : ""}${name}`,
      callback_data: `t:${task.id}:${personKey(name)}`,
    }));
    lines.push("", "Отметьте исполнителей и нажмите «Готово».");
    return {
      text: lines.join("\n"),
      keyboard: [
        ...rows(people, 2),
        [{ text: "Готово", callback_data: `d:${task.id}` }, cancel],
      ],
    };
  }

  const keyboard: Keyboard = [
    [cancel, { text: "👤 Исполнители", callback_data: `p:${task.id}` }],
  ];
  // У подзадачи своей карточки в CRM нет, открывается родитель.
  const link = taskButton(task.parent?.id ?? task.id, env.CRM_ORIGIN);
  if (link) keyboard.push([link]);
  return { text: lines.join("\n"), keyboard };
}

/**
 * Уведомление исполнителям уходит не сразу, а через минуту: за это время автор видит
 * карточку и успевает отменить задачу или поправить исполнителя. Иначе человек получил
 * бы задачу, которой уже нет, или чужую. Перезапуск сервера в эту минуту уведомление
 * не теряет: остановка бота отправляет всё, что ждёт.
 */
export const NOTIFY_DELAY_MS = 60_000;

interface Notice {
  taskId: string;
  /** Автору писать не о чем: он сам поставил задачу и видит карточку. */
  author: string | null;
  /** Кому уже пишут о родителе: о его подзадаче второе сообщение не нужно. */
  skip: string[];
}

const pending = new Map<string, { timer: NodeJS.Timeout; notice: Notice; log: Log }>();
/** Отменённые до уведомления: если задачу вернут, уведомление ещё должно уйти. */
const held = new Map<string, Notice>();

async function sendNotice(notice: Notice, log: Log): Promise<void> {
  const task = await prisma.task.findFirst({
    where: { id: notice.taskId, archivedAt: null, AND: [liveTask] },
    include: TASK_RELATIONS,
  });
  if (!task || isClosed(task.status)) return;

  const people = task.developers.filter(
    (name) => name !== notice.author && !notice.skip.includes(name),
  );
  // Все исполнители — это автор и те, кому уже пишут: будить некого. Задача без
  // исполнителя уходит в общий чат, как и поставленная в CRM: там её кто-то возьмёт.
  if (task.developers.length > 0 && people.length === 0) return;
  await notifyTask(task, people, log, { teamChat: true });
}

function fire(taskId: string): Promise<void> {
  const entry = pending.get(taskId);
  if (!entry) return Promise.resolve();
  clearTimeout(entry.timer);
  pending.delete(taskId);
  return sendNotice(entry.notice, entry.log).catch((cause: unknown) => {
    entry.log.warn({ err: cause }, "уведомление о задаче из телеграма не отправлено");
  });
}

export function scheduleNotice(notice: Notice, log: Log): void {
  const previous = pending.get(notice.taskId);
  if (previous) clearTimeout(previous.timer);
  const timer = setTimeout(() => void fire(notice.taskId), NOTIFY_DELAY_MS);
  pending.set(notice.taskId, { timer, notice, log });
}

/** Остановка сервера: ждущие уведомления уходят сразу, но не дольше десяти секунд. */
export async function flushNotices(): Promise<void> {
  const all = Promise.allSettled([...pending.keys()].map(fire));
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

function hold(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(taskId);
  held.set(taskId, entry.notice);
}

function release(taskId: string, log: Log): void {
  const notice = held.get(taskId);
  if (!notice) return;
  held.delete(taskId);
  scheduleNotice(notice, log);
}

/** Кто нажал кнопку. Как и `/today`, роль читается при каждом нажатии. */
async function presserOf(telegramId: number): Promise<Viewer | null> {
  const user = await prisma.user.findFirst({
    where: { telegramChatId: String(telegramId), disabledAt: null },
    include: WITH_MEMBER,
  });
  if (!user || (user.role !== "admin" && user.role !== "employee")) return null;
  return { id: user.id, role: user.role, memberName: memberNameOf(user) };
}

/**
 * Менять задачу с карточки может её автор или админ. Автору мало авторства: задача ещё
 * должна быть ему видна. Иначе снятый с чужой задачи человек вписал бы себя обратно в
 * свою подзадачу старой кнопкой и снова открыл родителя, а `access.ts` закрывает именно
 * этот ход.
 */
async function mayChange(viewer: Viewer, task: CardTask): Promise<boolean> {
  if (isAdmin(viewer)) return true;
  if (task.createdById !== viewer.id) return false;
  const visible = await prisma.task.count({
    where: task.deletedAt
      ? { id: task.id, AND: [taskScope(viewer)] }
      : reachableTask(task.id, viewer),
  });
  return visible > 0;
}

export async function handleCardAction(query: TgCallbackQuery, log: Log): Promise<void> {
  const [action = "", taskId = "", key = ""] = (query.data ?? "").split(":");
  const message = query.message;
  if (!message || !UUID.test(taskId)) {
    await answerCallback(query.id);
    return;
  }

  const viewer = await presserOf(query.from.id);
  if (!viewer) {
    await answerCallback(query.id, "Кнопки работают у тех, кто подключил бота в CRM.");
    return;
  }

  const task = await loadCardTask(taskId);
  if (!task) {
    await answerCallback(query.id, "Этой задачи больше нет.");
    return;
  }
  if (!(await mayChange(viewer, task))) {
    await answerCallback(query.id, "Менять задачу отсюда может её автор или админ.");
    return;
  }

  let view: CardView = "main";
  let toast: string | undefined;

  if (action === "c" && !task.deletedAt) {
    // Мягкое удаление, как в CRM: задача уходит в Корзину, подзадачи — вместе с ней.
    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
    hold(task.id);
    await auditAs(
      viewer.id,
      {
        entity: "tasks",
        entityId: task.id,
        action: "delete",
        diff: { title: task.title, via: "telegram" },
      },
      log,
    );
    toast = "Задача отменена";
  } else if (action === "r" && task.deletedAt) {
    await prisma.task.update({ where: { id: task.id }, data: { deletedAt: null } });
    release(task.id, log);
    await auditAs(
      viewer.id,
      {
        entity: "tasks",
        entityId: task.id,
        action: "restore",
        diff: { via: "telegram" },
      },
      log,
    );
    toast = "Задача возвращена";
  } else if (action === "p" || action === "t") {
    view = "people";
  }

  if (action === "t" && !task.deletedAt) {
    toast = await togglePerson(viewer, task, key, log);
  }

  const fresh = await loadCardTask(task.id);
  await answerCallback(query.id, toast);
  if (!fresh) return;
  const card = await renderCard(fresh, fresh.deletedAt ? "main" : view);
  await editMessage(
    String(message.chat.id),
    message.message_id,
    card.text,
    card.keyboard,
  );
}

async function togglePerson(
  viewer: Viewer,
  task: CardTask,
  key: string,
  log: Log,
): Promise<string | undefined> {
  const names = [
    ...(await loadPeople()).map((person) => person.name),
    ...task.developers,
  ];
  const name = names.find((candidate) => personKey(candidate) === key);
  if (!name) return "Этого человека уже нет в команде";

  const developers = task.developers.includes(name)
    ? task.developers.filter((person) => person !== name)
    : [...task.developers, name];
  const problem = await assertDevelopers(developers);
  if (problem) return problem;

  const updated = await prisma.task.update({
    where: { id: task.id },
    data: { developers },
    include: TASK_RELATIONS,
  });
  await auditAs(
    viewer.id,
    {
      entity: "tasks",
      entityId: task.id,
      action: "update",
      diff: { developers, via: "telegram" },
    },
    log,
  );

  // Пока уведомление ждёт, оно само прочтёт новый список. Если уже ушло — пишем только
  // добавленному, как и правка в CRM: снятых и прежних это не касается.
  const added = developers.includes(name) && name !== memberNameOf(viewer);
  if (!pending.has(task.id) && !held.has(task.id) && added && !isClosed(updated.status)) {
    void notifyTask(updated, [name], log, { teamChat: true }).catch((cause: unknown) => {
      log.warn({ err: cause }, "уведомление о задаче из телеграма не отправлено");
    });
  }
  return undefined;
}
