import { auditAs } from "../audit.js";
import {
  reachableTask,
  setTaskArchived,
  updateTask,
  type UpdateTaskInput,
} from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  archiveMessage,
  myTasksMessage,
  renderTaskList,
  type ListKind,
} from "./my-tasks.js";
import { afterTaskUpdate, refreshReviews } from "./after-update.js";
import { countFiles, isPrivateChat } from "./notifications.js";
import { askForInput } from "./pending.js";
import { answerQuestion, recallQuestion } from "./questions.js";
import { deadlinesList } from "./reminders.js";
import { handleEdit } from "./task-edit.js";
import { sendTaskFiles } from "./task-files.js";
import {
  listKindOf,
  refreshTaskMessage,
  renderTask,
  TASK_VIEW,
  viewOf,
} from "./task-view.js";
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
  if (kind === "a") return archiveMessage(viewer);
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
  return Boolean(data && /^[sobe]:/.test(data));
}

export async function handleTaskAction(query: TgCallbackQuery, log: Log): Promise<void> {
  const parts = (query.data ?? "").split(":");
  const taskId = parts.at(-1) ?? "";
  const message = query.message;
  const back = parts[0] === "b";
  // У кнопок правки в конце код или ключ, а не id: их данные разбирает `handleEdit`.
  const edit = parts[0] === "e";
  if (!message || (!back && !edit && !UUID.test(taskId))) {
    await answerCallback(query.id);
    return;
  }

  const presser = await teamUserOf(query.from.id);
  if (!presser) {
    await answerCallback(query.id, "Кнопки работают у тех, кто подключил бота в CRM.");
    return;
  }

  const chatId = String(message.chat.id);

  if (parts[0] === "e") return handleEdit(query, presser, log);

  if (back) {
    const list = await listFor(
      listKindOf(parts[1]),
      presser.viewer,
      chatId,
      message.message_id,
    );
    await Promise.all([
      answerCallback(query.id),
      editMessage(chatId, message.message_id, list.text, list.keyboard ?? []),
    ]);
    return;
  }

  // Задача открывается на месте списка, а «Назад» возвращает список: так переписка не
  // растёт от каждой открытой задачи, и путь обратно — одна кнопка.
  if (parts[0] === "o") {
    const task = await prisma.task.findFirst({
      where: reachableTask(taskId, presser.viewer),
      include: TASK_VIEW,
    });
    if (!task) {
      await answerCallback(query.id, "Эта задача вам недоступна.");
      return;
    }
    const kind = listKindOf(parts.length === 3 ? parts[1] : "m");
    const view = await renderTask(task, { project: true, back: kind });
    await Promise.all([
      answerCallback(query.id),
      editMessage(chatId, message.message_id, view.text, view.keyboard),
    ]);
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
    await Promise.all([
      answerCallback(query.id),
      askForInput({
        kind: code,
        taskId,
        chatId,
        telegramId: query.from.id,
        name: presser.name,
        source: {
          messageId: message.message_id,
          view: viewOf(message.reply_markup, message.text),
        },
      }),
    ]);
    return;
  }

  // «☑️ Проверено»: сделанная задача принята и уходит с доски в архив. Это ручной архив
  // CRM, и решает его админ; «↩️ Вернуть в работу» вернёт её на доску.
  if (code === "chk") {
    const view = viewOf(message.reply_markup, message.text);
    // Кнопка могла остаться под сообщением, пока задачу вернули в работу: принимать
    // несделанное нельзя. Сообщение перерисовывается, и видно, что с задачей сейчас.
    const current = await prisma.task.findFirst({
      where: reachableTask(taskId, presser.viewer),
      select: { status: true },
    });
    if (current && current.status !== "done") {
      await Promise.all([
        answerCallback(query.id, "Задача уже не в «Готово» — проверять нечего"),
        refreshTaskMessage({ chatId, messageId: message.message_id, view, taskId }),
      ]);
      return;
    }
    const archived = await setTaskArchived(presser.viewer, taskId, true);
    if (!archived.ok) {
      await answerCallback(
        query.id,
        archived.code === 404 ? "Эта задача вам недоступна." : archived.error,
      );
      return;
    }
    await auditAs(
      presser.viewer.id,
      { entity: "tasks", entityId: taskId, action: "archive", diff: { via: "telegram" } },
      log,
    );
    const footer = `☑️ Проверено, в архиве · ${escapeHtml(presser.name)}`;
    await Promise.all([
      answerCallback(query.id, "Проверено — задача в архиве"),
      refreshTaskMessage({ chatId, messageId: message.message_id, view, taskId, footer }),
      // У других админов то же сообщение «на проверку»: видно, что задачу уже приняли.
      refreshReviews(taskId, footer, log, { chatId, messageId: message.message_id }),
    ]);
    return;
  }

  if (code === "show") {
    await showFiles(query, presser, taskId, log);
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
  const audited = auditAs(
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
    {
      existing,
      task,
      actor: { id: presser.viewer.id, name: presser.name },
      source: { chatId, messageId: message.message_id },
    },
    log,
  );

  // Ответ на нажатие и перерисовка — одновременно: каждый из них ходит в телеграм через
  // туннель, и по очереди нажатие ждало бы два пути туда и обратно.
  await Promise.all([
    audited,
    answerCallback(query.id, action.toast),
    refreshTaskMessage({
      chatId,
      messageId: message.message_id,
      view: viewOf(message.reply_markup, message.text),
      taskId: task.id,
      footer: footerOf(code, task, presser.name),
    }),
  ]);
}

/** Кому сейчас уходят файлы какой задачи: второе нажатие, пока идёт первое, не дублирует альбом. */
const sendingFiles = new Set<string>();

/**
 * «🗂 Файлы»: скриншоты и документы задачи в чат. Только лично тому, кто нажал: в файлах
 * бывают данные клиентов, и в общем чате их увидели бы те, кому задача в CRM не видна. В
 * личке файлы приходят ответом на сообщение о задаче, из общего чата — отдельно.
 *
 * Загрузка идёт в фоне: несколько скриншотов через туннель — это секунды, и все это время
 * остальные кнопки человека ждали бы своей очереди.
 */
async function showFiles(
  query: TgCallbackQuery,
  presser: TeamUser,
  taskId: string,
  log: Log,
): Promise<void> {
  const message = query.message!;
  const chatId = String(message.chat.id);
  const task = await prisma.task.findFirst({
    where: reachableTask(taskId, presser.viewer),
    select: { id: true, title: true, parent: { select: { id: true, title: true } } },
  });
  // Файлы подзадачи лежат у родителя: смотреть их можно, только если виден и он, как в CRM.
  const owner = task?.parent ?? task;
  const visible =
    owner &&
    (owner === task ||
      (await prisma.task.count({ where: reachableTask(owner.id, presser.viewer) })) > 0);
  if (!owner || !visible) {
    await answerCallback(query.id, "Эта задача вам недоступна.");
    return;
  }

  const count = await countFiles(owner.id);
  if (count === 0) {
    // Файлы удалили в CRM, а кнопка осталась: сообщение перерисуется уже без неё.
    await Promise.all([
      answerCallback(query.id, "Файлов у задачи уже нет"),
      refreshTaskMessage({
        chatId,
        messageId: message.message_id,
        view: viewOf(message.reply_markup, message.text),
        taskId,
      }),
    ]);
    return;
  }

  const inPrivate = isPrivateChat(chatId);
  const target = inPrivate ? chatId : String(query.from.id);
  const key = `${target}:${owner.id}`;
  if (sendingFiles.has(key)) {
    await answerCallback(query.id, "Уже отправляю");
    return;
  }
  sendingFiles.add(key);
  await answerCallback(
    query.id,
    inPrivate ? "Отправляю файлы…" : "Файлы придут вам в личные сообщения с ботом",
  );
  void sendTaskFiles(
    {
      taskId: owner.id,
      title: owner.title,
      chatId: target,
      replyTo: inPrivate ? message.message_id : undefined,
    },
    log,
  )
    .catch((cause: unknown) => log.warn({ err: cause }, "файлы задачи не отправлены"))
    .finally(() => sendingFiles.delete(key));
}
