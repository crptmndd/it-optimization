import { TASK_RELATIONS } from "../crm/tasks/dto.js";
import type { CreatedTask } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { loadCardTask, renderCard } from "./intake/cards.js";
import { attachmentsLine } from "./intake/files.js";
import type { ListKind } from "./my-tasks.js";
import { taskKeyboard, taskMessage } from "./notifications.js";
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

export function listKindOf(value: string | undefined): ListKind {
  return LIST_KINDS.includes(value ?? "") ? (value as ListKind) : "m";
}

/** Кнопки уже отправленного сообщения: телеграм присылает их вместе с нажатием. */
export interface SentMarkup {
  inline_keyboard?: { callback_data?: string }[][];
}

/** Из какого списка открыта задача — по её кнопке «Назад». Нет кнопки — ни из какого. */
export function backOf(markup: SentMarkup | undefined): ListKind | undefined {
  const data = markup?.inline_keyboard
    ?.flat()
    .find((button) => button.callback_data?.startsWith("b:"))?.callback_data;
  return data ? listKindOf(data.slice(2)) : undefined;
}

/**
 * Перерисовать сообщение о задаче после правки, сохранив его вид: карточка остаётся
 * карточкой (её узнаём по кнопке «Отменить», `c:`), задача из списка — с проектом и
 * «Назад», уведомление — по шаблону. Строка о действии встаёт вниз.
 */
export async function refreshTaskMessage(input: {
  chatId: string;
  messageId: number;
  markup?: SentMarkup;
  text?: string;
  taskId: string;
  footer?: string;
}): Promise<void> {
  const isCard = input.markup?.inline_keyboard
    ?.flat()
    .some((button) => button.callback_data?.startsWith("c:"));
  if (isCard) {
    const card = await loadCardTask(input.taskId);
    if (!card) return;
    const view = await renderCard(card, "main", input.footer ? [input.footer] : []);
    await editMessage(input.chatId, input.messageId, view.text, view.keyboard);
    return;
  }

  const fresh = await prisma.task.findUnique({
    where: { id: input.taskId },
    include: TASK_VIEW,
  });
  if (!fresh) return;
  // У старых задач из списка «Назад» ещё нет — их выдаёт строка проекта.
  const back = backOf(input.markup);
  const view = await renderTask(fresh, {
    footer: input.footer,
    project: Boolean(back) || Boolean(input.text?.includes("📁 Проект:")),
    back,
  });
  await editMessage(input.chatId, input.messageId, view.text, view.keyboard);
}
