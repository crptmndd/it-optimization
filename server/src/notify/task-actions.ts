import { auditAs } from "../audit.js";
import { TASK_RELATIONS } from "../crm/tasks/dto.js";
import {
  reachableTask,
  updateTask,
  type CreatedTask,
  type UpdateTaskInput,
} from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { afterTaskUpdate, taskKeyboard, taskMessage } from "./notifications.js";
import { loadCardTask, renderCard } from "./intake/cards.js";
import { attachmentsLine } from "./intake/files.js";
import { myTasksMessage, renderTaskList, type ListKind } from "./my-tasks.js";
import { answerQuestion, recallQuestion } from "./questions.js";
import { deadlinesList } from "./reminders.js";
import { teamUserOf, type TeamUser } from "./team-user.js";
import {
  answerCallback,
  editMessage,
  escapeHtml,
  type Keyboard,
  type TgCallbackQuery,
} from "./telegram.js";
import { formatDate, startOfTomorrow } from "./zone.js";

/**
 * Кнопки под сообщениями о задачах: «Готово», «В работу», «На завтра», «Вернуть в
 * работу» и открытие задачи из списка `/tasks`. Правка идёт через `updateTask`, тот же,
 * что у формы CRM: нажать может только тот, кому задача видна в CRM, а колонка, дата
 * закрытия и архив меняются по тем же правилам. После нажатия сообщение перерисовывается
 * из базы, и в общем чате все видят, что задачу уже закрыли.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_VIEW = {
  ...TASK_RELATIONS,
  project: { select: { id: true, title: true } },
} as const;

/** Конец завтрашнего дня в поясе команды — так срок ставит форма CRM. */
export function endOfTomorrow(): Date {
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  const after = startOfTomorrow(env.TIMEZONE, new Date(tomorrow.getTime() + 3_600_000));
  return new Date(after.getTime() - 1000);
}

async function noteOf(task: { id: string; description: string | null }) {
  const note = await prisma.note.findFirst({
    where: { entity: "task", entityId: task.id },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  return note?.body ?? task.description;
}

/**
 * Задача тем же видом, что и уведомление о ней, плюс строка о последнем действии.
 * Проект показывается только в карточке из `/tasks`: в уведомлении его нет по шаблону
 * владельца, и перерисовка не должна его туда добавлять.
 */
export async function renderTask(
  task: CreatedTask & { project: { title: string } | null },
  options: { footer?: string; project?: boolean; back?: ListKind } = {},
): Promise<{ text: string; keyboard: Keyboard }> {
  const lines = [
    taskMessage({
      task,
      note: await noteOf(task),
      people: task.developers.map(escapeHtml),
      timeZone: env.TIMEZONE,
    }),
  ];
  if (options.project && task.project) {
    lines.push(`📁 Проект: ${escapeHtml(task.project.title)}`);
  }
  const files = await attachmentsLine(task.parent?.id ?? task.id);
  if (files) lines.push(files);
  if (options.footer) lines.push("", options.footer);
  const keyboard = taskKeyboard(task);
  if (options.back) withBack(keyboard, options.back);
  return { text: lines.join("\n"), keyboard };
}

/**
 * «⬅️ Назад» к списку, из которого открыли задачу, — слева от «Открыть задачу». Без
 * боевого адреса CRM ссылки нет, и кнопка встаёт одна.
 */
function withBack(keyboard: Keyboard, kind: ListKind): void {
  const back = { text: "⬅️ Назад", callback_data: `b:${kind}` };
  const linkRow = keyboard.find((row) => row.some((button) => "url" in button));
  if (linkRow) linkRow.unshift(back);
  else keyboard.push([back]);
}

const LIST_KINDS: readonly string[] = ["m", "r", "q"];

function listKindOf(value: string | undefined): ListKind {
  return LIST_KINDS.includes(value ?? "") ? (value as ListKind) : "m";
}

/** Из какого списка открыта задача — по её кнопке «Назад». Нет кнопки — ни из какого. */
function backOf(message: NonNullable<TgCallbackQuery["message"]>): ListKind | undefined {
  const data = message.reply_markup?.inline_keyboard
    ?.flat()
    .find((button) => button.callback_data?.startsWith("b:"))?.callback_data;
  return data ? listKindOf(data.slice(2)) : undefined;
}

/**
 * Список заново, в том же сообщении: закрытая только что задача из него уже ушла. Сроки
 * и «мои задачи» собираются из базы, вопрос — из памяти (`recallQuestion`); забытый
 * после перезапуска вопрос даёт «Мои задачи».
 */
async function listFor(
  kind: ListKind,
  viewer: TeamUser["viewer"],
  chatId: string,
  messageId: number,
): Promise<{ text: string; keyboard?: Keyboard }> {
  if (kind === "r") {
    return (
      (await deadlinesList(viewer)) ??
      renderTaskList("⏰ Сроков на сегодня и завтра больше нет.", [], "r")
    );
  }
  if (kind === "q") {
    const asked = recallQuestion(chatId, messageId);
    if (asked) return answerQuestion(viewer, asked);
  }
  return myTasksMessage(viewer);
}

const ACTIONS: Record<string, { input: () => UpdateTaskInput; toast: string }> = {
  done: { input: () => ({ status: "done" }), toast: "Задача закрыта" },
  work: { input: () => ({ status: "in_progress" }), toast: "Задача в работе" },
  back: { input: () => ({ status: "todo" }), toast: "Задача снова в работе" },
  tmrw: { input: () => ({ dueAt: endOfTomorrow() }), toast: "Срок — завтра" },
};

function footerOf(code: string, task: { dueAt: Date | null }, who: string): string {
  const name = escapeHtml(who);
  switch (code) {
    case "done":
      return `✅ Выполнено · ${name}`;
    case "work":
      return `▶️ В работе · ${name}`;
    case "back":
      return `↩️ Возвращена в работу · ${name}`;
    default:
      return `📅 Срок перенесён на ${task.dueAt ? formatDate(task.dueAt, env.TIMEZONE) : "завтра"} · ${name}`;
  }
}

/**
 * `s:<действие>:<id>` — действие с задачей, `o:<список>:<id>` — открыть её из списка
 * (у старых сообщений без списка: `o:<id>`), `b:<список>` — назад к списку.
 */
export function isTaskAction(data: string | undefined): boolean {
  return Boolean(data && /^[sob]:/.test(data));
}

export async function handleTaskAction(query: TgCallbackQuery, log: Log): Promise<void> {
  const parts = (query.data ?? "").split(":");
  const taskId = parts.at(-1) ?? "";
  const message = query.message;
  const back = parts[0] === "b";
  if (!message || (!back && !UUID.test(taskId))) {
    await answerCallback(query.id);
    return;
  }

  const presser = await teamUserOf(query.from.id);
  if (!presser) {
    await answerCallback(query.id, "Кнопки работают у тех, кто подключил бота в CRM.");
    return;
  }

  const chatId = String(message.chat.id);

  if (back) {
    const list = await listFor(
      listKindOf(parts[1]),
      presser.viewer,
      chatId,
      message.message_id,
    );
    await answerCallback(query.id);
    await editMessage(chatId, message.message_id, list.text, list.keyboard ?? []);
    return;
  }

  // Задача открывается на месте списка, а «Назад» возвращает список: так переписка не
  // растёт от каждой открытой задачи, и путь обратно — одна кнопка.
  if (parts[0] === "o") {
    const task = await prisma.task.findFirst({
      where: reachableTask(taskId, presser.viewer),
      include: TASK_VIEW,
    });
    await answerCallback(query.id, task ? undefined : "Эта задача вам недоступна.");
    if (!task) return;
    const kind = listKindOf(parts.length === 3 ? parts[1] : "m");
    const view = await renderTask(task, { project: true, back: kind });
    await editMessage(chatId, message.message_id, view.text, view.keyboard);
    return;
  }

  const code = parts[1] ?? "";
  const action = ACTIONS[code];
  if (!action) {
    await answerCallback(query.id);
    return;
  }

  const input = action.input();
  const result = await updateTask(presser.viewer, taskId, input);
  if (!result.ok) {
    // Чужая задача отвечает тем же 404, что и пустая: существование не подтверждаем.
    await answerCallback(
      query.id,
      result.code === 404 ? "Эта задача вам недоступна." : result.error,
    );
    return;
  }

  const { task, existing } = result;
  await auditAs(
    presser.viewer.id,
    {
      entity: "tasks",
      entityId: task.id,
      action: "update",
      diff: {
        via: "telegram",
        ...(input.status && { status: input.status }),
        ...(input.dueAt && { dueAt: input.dueAt.toISOString() }),
      },
    },
    log,
  );
  afterTaskUpdate(
    { existing, task, actor: { id: presser.viewer.id, name: presser.name } },
    log,
  );

  await answerCallback(query.id, action.toast);

  // Карточка поставленной задачи остаётся карточкой: с «Исполнителями» и «Отменить», а
  // строка о действии встаёт вниз. Узнаётся она по своей кнопке «Отменить» (`c:`).
  const isCard = message.reply_markup?.inline_keyboard
    ?.flat()
    .some((button) => button.callback_data?.startsWith("c:"));
  if (isCard) {
    const card = await loadCardTask(task.id);
    if (!card) return;
    const view = await renderCard(card, "main", [footerOf(code, card, presser.name)]);
    await editMessage(
      String(message.chat.id),
      message.message_id,
      view.text,
      view.keyboard,
    );
    return;
  }

  const fresh = await prisma.task.findUnique({
    where: { id: task.id },
    include: TASK_VIEW,
  });
  if (!fresh) return;
  // Задача из списка показывает проект и «Назад», уведомление — ни того ни другого.
  // Различает их кнопка «Назад» в самом сообщении, а у старых — строка проекта.
  const listKind = backOf(message);
  const view = await renderTask(fresh, {
    footer: footerOf(code, fresh, presser.name),
    project: Boolean(listKind) || Boolean(message.text?.includes("📁 Проект:")),
    back: listKind,
  });
  await editMessage(
    String(message.chat.id),
    message.message_id,
    view.text,
    view.keyboard,
  );
}
