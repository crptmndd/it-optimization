import { TASK_RELATIONS } from "../crm/tasks/dto.js";
import type { CreatedTask } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { loadCardTask, renderCard } from "./intake/cards.js";
import type { ListKind } from "./my-tasks.js";
import { countFiles, filesLine, taskKeyboard, taskMessage } from "./notifications.js";
import { editMessage, escapeHtml, type Keyboard } from "./telegram.js";

/**
 * Сообщение о задаче в телеграме и его перерисовка после правки. Сообщения трёх видов:
 * карточка поставленной задачи (с «Исполнителями» и «Отменить»), задача, открытая из
 * списка (с проектом и «Назад»), и уведомление (по шаблону владельца, без проекта).
 * Различаются они кнопками самого сообщения, поэтому перерисовка смотрит на них.
 */

export const TASK_VIEW = {
  ...TASK_RELATIONS,
  project: { select: { id: true, title: true } },
} as const;

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
 * Проект показывается только в задаче из списка: в уведомлении его нет по шаблону
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
  const files = await countFiles(task.parent?.id ?? task.id);
  const line = filesLine(files);
  if (line) lines.push(line);
  if (options.footer) lines.push("", options.footer);
  const keyboard = taskKeyboard({ ...task, files });
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

const LIST_KINDS: readonly string[] = ["m", "r", "q", "a"];

export function listKindOf(value: string | undefined): ListKind {
  return LIST_KINDS.includes(value ?? "") ? (value as ListKind) : "m";
}

/** Кнопки уже отправленного сообщения: телеграм присылает их вместе с нажатием. */
export interface SentMarkup {
  inline_keyboard?: { callback_data?: string }[][];
}

/**
 * Вид сообщения о задаче: `c` — карточка поставленной задачи, `n` — уведомление,
 * `m`/`r`/`q` — задача, открытая из списка (своего, сроков или ответа на вопрос). Меню
 * правки временно заменяет кнопки и несёт вид в своих данных (`e:<действие>:<вид>:<id>`),
 * чтобы вернуть сообщение в прежний вид, а не в чужой.
 */
export type ViewKind = "c" | "n" | ListKind;

const VIEWS: readonly string[] = ["c", "n", "m", "r", "q", "a"];

export function viewKindOf(value: string | undefined): ViewKind {
  return VIEWS.includes(value ?? "") ? (value as ViewKind) : "n";
}

/** Вид по кнопкам уже отправленного сообщения. */
export function viewOf(markup: SentMarkup | undefined, text?: string): ViewKind {
  const buttons = markup?.inline_keyboard?.flat() ?? [];
  const data = (prefix: string) =>
    buttons.find((button) => button.callback_data?.startsWith(prefix))?.callback_data;
  if (data("c:")) return "c";
  const back = data("b:");
  if (back) return listKindOf(back.slice(2));
  const edit = data("e:")?.split(":");
  if (edit && edit.length >= 4) return viewKindOf(edit[2]);
  // Задача из списка, открытая до кнопки «Назад», узнаётся по строке проекта.
  if (text?.includes("📁 Проект:")) return "m";
  return "n";
}

/** Задача в своём виде. `null` — задачи больше нет. */
export async function renderView(
  taskId: string,
  view: ViewKind,
  footer?: string,
): Promise<{ text: string; keyboard: Keyboard } | null> {
  if (view === "c") {
    const card = await loadCardTask(taskId);
    return card ? renderCard(card, "main", footer ? [footer] : []) : null;
  }
  const fresh = await prisma.task.findUnique({
    where: { id: taskId },
    include: TASK_VIEW,
  });
  if (!fresh) return null;
  const list = view === "n" ? undefined : view;
  return renderTask(fresh, { footer, project: Boolean(list), back: list });
}

/**
 * Перерисовать сообщение о задаче после правки, сохранив его вид. Строка о действии
 * встаёт вниз.
 */
export async function refreshTaskMessage(input: {
  chatId: string;
  messageId: number;
  view: ViewKind;
  taskId: string;
  footer?: string;
}): Promise<void> {
  const view = await renderView(input.taskId, input.view, input.footer);
  if (view) await editMessage(input.chatId, input.messageId, view.text, view.keyboard);
}
