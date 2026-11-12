import { auditAs } from "../audit.js";
import { reachableTask, updateTask, type UpdateTaskInput } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { myTasksMessage, renderTaskList, type ListKind } from "./my-tasks.js";
import { afterTaskUpdate } from "./notifications.js";
import { askForInput } from "./pending.js";
import { answerQuestion, recallQuestion } from "./questions.js";
import { deadlinesList } from "./reminders.js";
import { listKindOf, refreshTaskMessage, renderTask, TASK_VIEW } from "./task-view.js";
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
 * Кнопки под сообщениями о задачах: «Готово», «В работу», «Вернуть в работу», «Изменить
 * срок», «Прикрепить файл», открытие задачи из списка и «Назад» к нему. Правка идёт через
 * `updateTask`, тот же, что у формы CRM: нажать может только тот, кому задача видна в
 * CRM, а колонка, дата закрытия и архив меняются по тем же правилам. После нажатия
 * сообщение перерисовывается из базы, и в общем чате все видят, что задачу уже закрыли.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Конец завтрашнего дня в поясе команды — так срок ставит форма CRM. */
export function endOfTomorrow(): Date {
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  const after = startOfTomorrow(env.TIMEZONE, new Date(tomorrow.getTime() + 3_600_000));
  return new Date(after.getTime() - 1000);
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

/**
 * Мгновенные действия. `tmrw` — «На завтра» у сообщений, отправленных до «Изменить
 * срок»: их кнопки продолжают работать.
 */
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

  // Срок и файл не меняют задачу сразу: бот спрашивает, ответ разбирает `pending.ts`.
  if (code === "due" || code === "file") {
    const task = await prisma.task.count({
      where: reachableTask(taskId, presser.viewer),
    });
    if (!task) {
      await answerCallback(query.id, "Эта задача вам недоступна.");
      return;
    }
    await answerCallback(query.id);
    await askForInput({
      kind: code,
      taskId,
      chatId,
      telegramId: query.from.id,
      name: presser.name,
      source: {
        messageId: message.message_id,
        markup: message.reply_markup,
        text: message.text,
      },
    });
    return;
  }

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
  await refreshTaskMessage({
    chatId,
    messageId: message.message_id,
    markup: message.reply_markup,
    text: message.text,
    taskId: task.id,
    footer: footerOf(code, task, presser.name),
  });
}
