import { createHash } from "node:crypto";
import type { TaskPriority } from "@prisma/client";
import { auditAs } from "../audit.js";
import { projectScope } from "../crm/access.js";
import { assertDevelopers } from "../crm/people.js";
import { deleteAttachments } from "../crm/tasks/attachments.js";
import { reachableTask, updateTask, type UpdateTaskInput } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { hasPendingNotice } from "./intake/cards.js";
import { loadPeople } from "./intake/parse.js";
import { afterTaskUpdate } from "./after-update.js";
import { countFiles } from "./notifications.js";
import { askForInput } from "./pending.js";
import {
  refreshTaskMessage,
  renderView,
  viewKindOf,
  viewOf,
  type SentMarkup,
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
 * важность, срок, исполнители, проект и удаление файлов. Важность, люди и проект выбираются кнопками,
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
  const files = await countFiles(id);
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
      ...(files > 0
        ? [
            [
              {
                text: `🗑 Удалить файлы (${files})`,
                callback_data: data("files", view, id),
              },
            ],
          ]
        : []),
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

/**
 * Удаление файлов: список с отметками, «Удалить выбранные» и «Удалить все». Что отмечено,
 * хранят кнопки самого сообщения (`e:fu:` — отмечен, `e:ft:` — нет): телеграм присылает
 * их с каждым нажатием, и памяти на сервере не нужно, даже если между нажатиями API
 * перезапустился. Файл в кнопке — по короткому ключу от его id, а не по номеру: номер
 * съехал бы, удали кто-то файл в CRM, пока меню открыто.
 */
async function filesMenu(
  taskId: string,
  view: ViewKind,
  selected: Set<string>,
): Promise<Menu | null> {
  const files = await prisma.taskAttachment.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
    select: { id: true, fileName: true, mimeType: true },
  });
  if (files.length === 0) return null;
  const options = files.map((file) => {
    const key = shortKey(file.id);
    const on = selected.has(key);
    const icon = file.mimeType.startsWith("image/") ? "🖼" : "📄";
    return [
      {
        text: `${on ? "☑️" : "▫️"} ${icon} ${shorten(file.fileName)}`,
        callback_data: data(on ? "fu" : "ft", view, taskId, key),
      },
    ];
  });
  const chosen = files.filter((file) => selected.has(shortKey(file.id))).length;
  return {
    text: await framed(
      taskId,
      view,
      "🗑 <b>Удалить файлы</b>: отметьте ненужные и нажмите «Удалить выбранные». Посмотреть их — «🗂 Файлы» под задачей.",
    ),
    keyboard: [
      ...options,
      [
        {
          text: chosen > 0 ? `🗑 Удалить выбранные (${chosen})` : "🗑 Удалить выбранные",
          callback_data: data("fx", view, taskId),
        },
      ],
      [
        {
          text: `🗑 Удалить все (${files.length})`,
          callback_data: data("fa", view, taskId),
        },
      ],
      [{ text: "⬅️ Назад", callback_data: data("menu", view, taskId) }],
    ],
  };
}

/** Отмеченные файлы — по кнопкам сообщения, на котором нажали. */
function selectedKeys(markup: SentMarkup | undefined): Set<string> {
  return new Set(
    (markup?.inline_keyboard ?? [])
      .flat()
      .map((button) => button.callback_data ?? "")
      .filter((value) => value.startsWith("e:fu:"))
      .map((value) => value.split(":")[4] ?? ""),
  );
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

  // Ответ на нажатие и правка сообщения — одновременно: по очереди нажатие ждало бы два
  // пути до телеграма и обратно.
  const show = async (menu: Menu, toast?: string) => {
    await Promise.all([
      answerCallback(query.id, toast),
      editMessage(chatId, message.message_id, menu.text, menu.keyboard),
    ]);
  };

  /** Файлов не осталось — например, их удалили в CRM, пока меню было открыто. */
  const noFiles = async (toast: string) => show(await mainMenu(task, view), toast);

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
    const audited = auditAs(
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
          source: { chatId, messageId: message.message_id },
        },
        log,
      );
    }
    if (footer) {
      await Promise.all([
        audited,
        answerCallback(query.id),
        refreshTaskMessage({
          chatId,
          messageId: message.message_id,
          view,
          taskId: task.id,
          footer: `${footer} · ${escapeHtml(presser.name)}`,
        }),
      ]);
    } else {
      await audited;
    }
    return true;
  };

  /** Удалить файлы, записать в журнал и вернуть сообщение в его вид со строкой внизу. */
  const removeFiles = async (ids: string[]) => {
    const removed = await deleteAttachments(task.id, ids);
    if (removed.length === 0) {
      const menu = await filesMenu(task.id, view, new Set());
      return menu
        ? show(menu, "Эти файлы уже удалены")
        : noFiles("Файлов у задачи уже нет");
    }
    await Promise.all([
      auditAs(
        presser.viewer.id,
        {
          entity: "tasks",
          entityId: task.id,
          action: "detach",
          diff: { via: "telegram", fileNames: removed.map((row) => row.fileName) },
        },
        log,
      ),
      answerCallback(query.id, `Удалено файлов: ${removed.length}`),
      refreshTaskMessage({
        chatId,
        messageId: message.message_id,
        view,
        taskId: task.id,
        footer: `🗑 Удалено файлов: ${removed.length} · ${escapeHtml(presser.name)}`,
      }),
    ]);
  };

  switch (action) {
    case "menu":
      return show(await mainMenu(task, view));
    case "files":
    case "ft":
    case "fu": {
      const selected =
        action === "files" ? new Set<string>() : selectedKeys(message.reply_markup);
      if (action === "ft" && extra) selected.add(extra);
      if (action === "fu" && extra) selected.delete(extra);
      const menu = await filesMenu(task.id, view, selected);
      return menu ? show(menu) : noFiles("Файлов у задачи уже нет");
    }
    case "fx": {
      const selected = selectedKeys(message.reply_markup);
      const files = await prisma.taskAttachment.findMany({
        where: { taskId: task.id },
        select: { id: true },
      });
      const ids = files
        .filter((file) => selected.has(shortKey(file.id)))
        .map((file) => file.id);
      if (ids.length === 0) {
        return answerCallback(query.id, "Сначала отметьте файлы, которые удалить");
      }
      return removeFiles(ids);
    }
    case "fa": {
      const count = await countFiles(task.id);
      if (count === 0) return noFiles("Файлов у задачи уже нет");
      return show({
        text: await framed(
          task.id,
          view,
          `🗑 <b>Удалить все файлы задачи (${count})?</b> Вернуть их будет нельзя.`,
        ),
        keyboard: [
          [{ text: "🗑 Да, удалить все", callback_data: data("fy", view, task.id) }],
          [{ text: "⬅️ Назад", callback_data: data("files", view, task.id) }],
        ],
      });
    }
    case "fy": {
      const files = await prisma.taskAttachment.findMany({
        where: { taskId: task.id },
        select: { id: true },
      });
      if (files.length === 0) return noFiles("Файлов у задачи уже нет");
      return removeFiles(files.map((file) => file.id));
    }
    case "back":
      await Promise.all([
        answerCallback(query.id),
        refreshTaskMessage({
          chatId,
          messageId: message.message_id,
          view,
          taskId: task.id,
        }),
      ]);
      return;
    case "title":
    case "note":
    case "due":
      await Promise.all([
        answerCallback(query.id),
        askForInput({
          kind: action,
          taskId: task.id,
          chatId,
          telegramId: query.from.id,
          name: presser.name,
          source: { messageId: message.message_id, view },
        }),
      ]);
      return;
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
