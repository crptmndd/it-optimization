import { createHash } from "node:crypto";
import type { TaskPriority } from "@prisma/client";
import { auditAs } from "../audit.js";
import { projectScope } from "../crm/access.js";
import { assertDevelopers } from "../crm/people.js";
import { reachableTask, updateTask, type UpdateTaskInput } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { hasPendingNotice } from "./intake/cards.js";
import { loadPeople } from "./intake/parse.js";
import { afterTaskUpdate } from "./notifications.js";
import { askForInput } from "./pending.js";
import {
  refreshTaskMessage,
  renderView,
  viewKindOf,
  viewOf,
  type ViewKind,
} from "./task-view.js";
import type { TeamUser } from "./team-user.js";
import {
  answerCallback,
  editMessage,
  escapeHtml,
  type InlineButton,
  type Keyboard,
  type TgCallbackQuery,
} from "./telegram.js";

/**
 * «✏️ Редактировать» под задачей: меню в том же сообщении — название, описание,
 * важность, срок, исполнители, проект. Важность, люди и проект выбираются кнопками,
 * название, описание и срок бот спрашивает текстом (`pending.ts`). Правка идёт через
 * `updateTask`, как форма CRM: поменять можно только видимую тебе задачу, и уведомления
 * новым исполнителям те же.
 *
 * Данные кнопок: `e:<действие>:<вид>:<id>[:<доп>]`. Вид — во что вернуть сообщение после
 * правки (карточка, уведомление, задача из списка): меню заменило его кнопки, и по ним
 * вид уже не узнать. Кнопка в самом сообщении — `e:menu:<id>`, вид там берётся из его
 * кнопок.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** В том же порядке, что в форме CRM, и с теми же словами. */
const PRIORITIES: { code: string; value: TaskPriority; label: string }[] = [
  { code: "l", value: "low", label: "🟢 Низкая" },
  { code: "n", value: "normal", label: "🟡 Обычная" },
  { code: "i", value: "important", label: "🟠 Высокая" },
  { code: "h", value: "high", label: "🔴 Срочно" },
];

/** Короткий ключ человека или проекта: имя и uuid не влезли бы в 64 байта кнопки. */
function shortKey(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function rows<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function data(action: string, view: ViewKind, id: string, extra?: string): string {
  return `e:${action}:${view}:${id}${extra ? `:${extra}` : ""}`;
}

type EditTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

function loadTask(id: string, presser: TeamUser) {
  return prisma.task.findFirst({
    where: reachableTask(id, presser.viewer),
    select: {
      id: true,
      priority: true,
      developers: true,
      projectId: true,
      parentId: true,
      project: { select: { id: true, title: true } },
    },
  });
}

/** Задача в своём виде и строка о том, что сейчас выбирают. */
async function framed(taskId: string, view: ViewKind, hint: string): Promise<string> {
  const rendered = await renderView(taskId, view);
  return rendered ? `${rendered.text}\n\n${hint}` : hint;
}

async function mainMenu(task: EditTask, view: ViewKind): Promise<Menu> {
  const id = task.id;
  return {
    text: await framed(id, view, "✏️ <b>Что изменить?</b>"),
    keyboard: [
      [
        { text: "✏️ Название", callback_data: data("title", view, id) },
        { text: "💬 Описание", callback_data: data("note", view, id) },
      ],
      [
        { text: "⚡ Важность", callback_data: data("prio", view, id) },
        { text: "📅 Срок", callback_data: data("due", view, id) },
      ],
      [
        { text: "👤 Исполнители", callback_data: data("ppl", view, id) },
        { text: "📁 Проект", callback_data: data("proj", view, id) },
      ],
      [{ text: "⬅️ Назад", callback_data: data("back", view, id) }],
    ],
  };
}

interface Menu {
  text: string;
  keyboard: Keyboard;
}

async function priorityMenu(task: EditTask, view: ViewKind): Promise<Menu> {
  const options = PRIORITIES.map((priority) => ({
    text: `${task.priority === priority.value ? "✓ " : ""}${priority.label}`,
    callback_data: data("ps", view, task.id, priority.code),
  }));
  return {
    text: await framed(task.id, view, "⚡ <b>Важность</b>"),
    keyboard: [
      ...rows(options, 2),
      [{ text: "⬅️ Назад", callback_data: data("menu", view, task.id) }],
    ],
  };
}

/** Команда и те, кто уже на задаче: отключённого можно снять, но не поставить. */
async function peopleOf(task: EditTask): Promise<string[]> {
  return [
    ...new Set([
      ...(await loadPeople()).map((person) => person.name),
      ...task.developers,
    ]),
  ];
}

async function peopleMenu(task: EditTask, view: ViewKind): Promise<Menu> {
  const people = (await peopleOf(task)).map((name) => ({
    text: `${task.developers.includes(name) ? "✅ " : ""}${name}`,
    callback_data: data("pt", view, task.id, shortKey(name)),
  }));
  return {
    text: await framed(
      task.id,
      view,
      "👤 <b>Исполнители</b>: отметьте, сохраняется сразу.",
    ),
    keyboard: [
      ...rows(people, 2),
      [{ text: "⬅️ Назад", callback_data: data("back", view, task.id) }],
    ],
  };
}

/** Открытые проекты, видимые человеку, — те же, что в выпадающем списке формы. */
async function projectsFor(presser: TeamUser) {
  return prisma.project.findMany({
    where: {
      deletedAt: null,
      archivedAt: null,
      status: { in: ["planned", "active", "on_hold"] },
      AND: [projectScope(presser.viewer)],
    },
    orderBy: { title: "asc" },
    take: 30,
    select: { id: true, title: true },
  });
}

function shorten(title: string): string {
  return title.length <= 32 ? title : `${title.slice(0, 31)}…`;
}

async function projectMenu(
  task: EditTask,
  view: ViewKind,
  presser: TeamUser,
): Promise<Menu> {
  const projects = await projectsFor(presser);
  // Закрытый или архивный проект задачи в списке не стоит, но выбранным он показан.
  if (task.project && !projects.some((project) => project.id === task.project!.id)) {
    projects.unshift(task.project);
  }
  const options: InlineButton[] = projects.map((project) => ({
    text: `${project.id === task.projectId ? "✓ " : ""}${shorten(project.title)}`,
    callback_data: data("pj", view, task.id, shortKey(project.id)),
  }));
  options.push({
    text: `${task.projectId ? "" : "✓ "}Без проекта`,
    callback_data: data("pj", view, task.id, "none"),
  });
  return {
    text: await framed(task.id, view, "📁 <b>Проект</b>"),
    keyboard: [
      ...rows(options, 1),
      [{ text: "⬅️ Назад", callback_data: data("menu", view, task.id) }],
    ],
  };
}

export async function handleEdit(
  query: TgCallbackQuery,
  presser: TeamUser,
  log: Log,
): Promise<void> {
  const message = query.message!;
  const chatId = String(message.chat.id);
  const parts = (query.data ?? "").split(":");
  const action = parts[1] ?? "";
  // `e:menu:<id>` — кнопка в самом сообщении о задаче, вид берётся из его кнопок.
  const fromTask = parts.length === 3;
  const view = fromTask
    ? viewOf(message.reply_markup, message.text)
    : viewKindOf(parts[2]);
  const taskId = (fromTask ? parts[2] : parts[3]) ?? "";
  const extra = parts[4];
  if (!UUID.test(taskId)) {
    await answerCallback(query.id);
    return;
  }

  const task = await loadTask(taskId, presser);
  if (!task) {
    await answerCallback(query.id, "Эта задача вам недоступна.");
    return;
  }

  const show = async (menu: Menu) => {
    await answerCallback(query.id);
    await editMessage(chatId, message.message_id, menu.text, menu.keyboard);
  };

  /** Правка задачи, журнал, уведомления и сообщение в прежнем виде со строкой внизу. */
  const apply = async (input: UpdateTaskInput, footer: string, notify = true) => {
    const result = await updateTask(presser.viewer, task.id, input);
    if (!result.ok) {
      await answerCallback(
        query.id,
        result.code === 404 ? "Эта задача вам недоступна." : result.error,
      );
      return false;
    }
    await auditAs(
      presser.viewer.id,
      {
        entity: "tasks",
        entityId: task.id,
        action: "update",
        diff: { via: "telegram", fields: Object.keys(input) },
      },
      log,
    );
    if (notify) {
      afterTaskUpdate(
        {
          existing: result.existing,
          task: result.task,
          actor: { id: presser.viewer.id, name: presser.name },
        },
        log,
      );
    }
    if (footer) {
      await answerCallback(query.id);
      await refreshTaskMessage({
        chatId,
        messageId: message.message_id,
        view,
        taskId: task.id,
        footer: `${footer} · ${escapeHtml(presser.name)}`,
      });
    }
    return true;
  };

  switch (action) {
    case "menu":
      return show(await mainMenu(task, view));
    case "back":
      await answerCallback(query.id);
      return refreshTaskMessage({
        chatId,
        messageId: message.message_id,
        view,
        taskId: task.id,
      });
    case "title":
    case "note":
    case "due":
      await answerCallback(query.id);
      return askForInput({
        kind: action,
        taskId: task.id,
        chatId,
        telegramId: query.from.id,
        name: presser.name,
        source: { messageId: message.message_id, view },
      });
    case "prio":
      return show(await priorityMenu(task, view));
    case "ps": {
      const priority = PRIORITIES.find((option) => option.code === extra);
      if (!priority) return answerCallback(query.id);
      await apply(
        { priority: priority.value },
        priority.label.replace(" ", " Важность: "),
      );
      return;
    }
    case "ppl":
      return show(await peopleMenu(task, view));
    case "pt": {
      const name = (await peopleOf(task)).find((person) => shortKey(person) === extra);
      if (!name) return answerCallback(query.id, "Этого человека уже нет в команде");
      const developers = task.developers.includes(name)
        ? task.developers.filter((person) => person !== name)
        : [...task.developers, name];
      const problem = await assertDevelopers(developers);
      if (problem) return answerCallback(query.id, problem);
      // Задачу только что поставили из сообщения, и уведомление ещё ждёт своей минуты:
      // оно само прочтёт новый список, второе сообщение человеку не нужно.
      const saved = await apply({ developers }, "", !hasPendingNotice(task.id));
      if (!saved) return;
      const fresh = await loadTask(task.id, presser);
      if (fresh) await show(await peopleMenu(fresh, view));
      return;
    }
    case "proj":
      return show(await projectMenu(task, view, presser));
    case "pj": {
      if (extra === "none") {
        await apply({ projectId: null }, "📁 Без проекта");
        return;
      }
      const projects = await projectsFor(presser);
      const project = projects.find((item) => shortKey(item.id) === extra);
      if (!project) return answerCallback(query.id, "Этот проект вам недоступен.");
      await apply({ projectId: project.id }, `📁 Проект: ${escapeHtml(project.title)}`);
      return;
    }
    default:
      await answerCallback(query.id);
  }
}
