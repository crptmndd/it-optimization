import { isClosed } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { canNotify } from "../env.js";
import {
  accountChatsOf,
  countFiles,
  isPrivateChat,
  notifyTaskInBackground,
  sendPrivate,
  taskKeyboard,
  type TaskNotice,
} from "./notifications.js";
import { refreshTaskMessage, renderView } from "./task-view.js";
import { escapeHtml, postMessage, TelegramError, type Keyboard } from "./telegram.js";

/**
 * Что бот говорит после правки задачи — одно правило для формы CRM, кнопок и ответов в
 * телеграме:
 *
 * - новых исполнителей будим, прежних нет: форма присылает весь список при каждом
 *   сохранении;
 * - закрытие задачи чужими руками — повод написать её автору, и только ему: о чужих
 *   задачах админа не будим. Если автор админ, а сделал сотрудник, это «выполнено,
 *   проверьте» с кнопками «☑️ Проверено» и «↩️ Вернуть в работу»;
 * - задачу вернули в работу — об этом узнают остальные исполнители, а у автора
 *   перерисовывается сообщение «на проверку».
 *
 * Всё это только о задачах верхнего уровня: подзадача — строка чек-листа, и каждая
 * галочка в нём будила бы людей.
 */

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

/** Где нажали кнопку: это сообщение перерисует сам обработчик нажатия. */
export interface SourceMessage {
  chatId: string;
  messageId: number;
}

export function afterTaskUpdate(
  change: {
    existing: { status: string; developers: string[] };
    task: TaskNotice & { parentId: string | null; createdById: string | null };
    actor: { id: string; name: string };
    teamChat?: boolean;
    source?: SourceMessage;
  },
  log: Log,
): void {
  const { existing, task, actor } = change;
  const added = task.developers.filter((name) => !existing.developers.includes(name));
  if (added.length > 0 && !isClosed(task.status)) {
    notifyTaskInBackground(task, added, log, {
      teamChat: change.teamChat !== false,
      skip: actor.name,
    });
  }

  if (existing.status !== task.status && task.parentId === null) {
    void reportStatus(change, log).catch((cause: unknown) => {
      log.warn({ err: cause }, "о смене статуса задачи не сообщили");
    });
  }
}

/** Строка о смене статуса под сообщением — те же слова, что у кнопок. */
export function statusFooter(from: string, to: string, who: string): string {
  const name = escapeHtml(who);
  if (to === "done") return `✅ Выполнено · ${name}`;
  if (to === "cancelled") return `✖️ Отменено · ${name}`;
  if (isClosed(from)) return `↩️ Возвращена в работу · ${name}`;
  if (to === "in_progress") return `▶️ В работе · ${name}`;
  return `📋 К работе · ${name}`;
}

async function reportStatus(
  change: Parameters<typeof afterTaskUpdate>[0],
  log: Log,
): Promise<void> {
  if (!canNotify) return;
  const { existing, task, actor } = change;

  await refreshReviews(
    task.id,
    statusFooter(existing.status, task.status, actor.name),
    log,
    change.source,
  );

  const closedNow = !isClosed(existing.status) && isClosed(task.status);
  if (closedNow && task.createdById && task.createdById !== actor.id) {
    const reviewed =
      task.status === "done" && (await sendReview(task.id, task.createdById, actor, log));
    if (!reviewed) await notifyAuthorClosed(task, actor.name, log);
  }

  if (isClosed(existing.status) && !isClosed(task.status)) {
    await notifyReopened(task, actor.name, log);
  }
}

const REVIEW_HINT =
  "«☑️ Проверено» уберёт задачу в архив, «↩️ Вернуть в работу» вернёт её исполнителю.";

/** Отправка с одним повтором: номер сообщения нужен, чтобы потом его перерисовать. */
async function post(
  chatId: string,
  text: string,
  keyboard: Keyboard,
  log: Log,
): Promise<number | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postMessage(chatId, text, { keyboard });
    } catch (cause) {
      const gone = cause instanceof TelegramError && cause.isGone;
      if (gone || attempt >= 2) {
        log.warn({ err: cause, chatId }, "сообщение «на проверку» не доставлено");
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * «Выполнено, проверьте» — автору задачи лично, если он админ, а сделал сотрудник: админ,
 * закрывший задачу сам, уже решил, а о чужих задачах админа не будим. Сообщение
 * запоминается в `task_review_messages`, чтобы перерисовать его, когда задачу вернут или
 * проверят. `false` — проверка тут ни при чём, и автору пишут обычное «выполнено».
 */
async function sendReview(
  taskId: string,
  authorId: string,
  actor: { id: string; name: string },
  log: Log,
): Promise<boolean> {
  const people = await prisma.user.findMany({
    where: { id: { in: [authorId, actor.id] } },
    select: { id: true, role: true, telegramChatId: true, disabledAt: true },
  });
  const author = people.find((person) => person.id === authorId);
  const doer = people.find((person) => person.id === actor.id);
  if (!author || author.role !== "admin" || author.disabledAt) return false;
  if (doer?.role === "admin") return false;

  const chatId = author.telegramChatId;
  if (!chatId || !isPrivateChat(chatId)) {
    log.warn({ authorId }, "автор не подключил бота, задача на проверку не отправлена");
    return true;
  }

  const view = await renderView(taskId, "n", REVIEW_HINT);
  if (!view) return true;
  // Заголовок первым: в уведомлении на телефоне видно начало, и по нему ясно, что это
  // не новая задача, а сделанная.
  const text = `✅ <b>Выполнено — проверьте</b> · ${escapeHtml(actor.name)}\n\n${view.text}`;

  const messageId = await post(chatId, text, view.keyboard, log);
  if (messageId === null) return true;
  await prisma.taskReviewMessage
    .create({ data: { taskId, chatId, messageId } })
    .catch((cause: unknown) =>
      log.warn({ err: cause }, "сообщение «на проверку» не запомнилось"),
    );
  return true;
}

/**
 * Перерисовать у автора сообщения «на проверку» этой задачи: её вернули в работу,
 * проверили или отменили. Без этого под задачей, которая снова в работе, висела бы
 * кнопка «Проверено». Удалённое человеком сообщение забывается.
 */
export async function refreshReviews(
  taskId: string,
  footer: string,
  log: Log,
  except?: SourceMessage,
): Promise<void> {
  if (!canNotify) return;
  const rows = await prisma.taskReviewMessage.findMany({ where: { taskId } });
  const others = rows.filter(
    (row) =>
      !except || row.chatId !== except.chatId || row.messageId !== except.messageId,
  );
  // Разом, а не по очереди: у каждого админа своё сообщение, и ждать друг друга им незачем.
  await Promise.all(
    others.map(async (row) => {
      try {
        await refreshTaskMessage({
          chatId: row.chatId,
          messageId: row.messageId,
          view: "n",
          taskId,
          footer,
        });
      } catch (cause) {
        if (cause instanceof TelegramError && cause.code === 400) {
          await prisma.taskReviewMessage
            .delete({ where: { id: row.id } })
            .catch(() => {});
        } else {
          log.warn({ err: cause }, "сообщение «на проверку» не перерисовалось");
        }
      }
    }),
  );
}

/** Через месяц сообщение «на проверку» давно прочитано: перерисовывать его незачем. */
export async function purgeOldReviews(): Promise<number> {
  const { count } = await prisma.taskReviewMessage.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  });
  return count;
}

/**
 * Задачу вернули в работу — остальным исполнителям лично: админ, вернувший сделанное на
 * доработку, иначе ждал бы, пока исполнитель сам заглянет в CRM. Тому, кто вернул, не
 * пишем.
 */
async function notifyReopened(task: TaskNotice, actor: string, log: Log): Promise<void> {
  const accounts = await accountChatsOf(task.developers);
  const chats = [...accounts]
    .filter(([name, account]) => name !== actor && account.chatId)
    .map(([, account]) => account.chatId!)
    .filter(isPrivateChat);
  if (chats.length === 0) return;

  const view = await renderView(task.id, "n");
  if (!view) return;
  const text = `↩️ <b>Возвращена в работу</b> · ${escapeHtml(actor)}\n\n${view.text}`;
  for (const chatId of chats) await sendPrivate(chatId, text, log, view.keyboard);
}

/**
 * Автору — что его задачу закрыли. Без этого автор узнаёт о выполнении, только открыв
 * CRM, и переспрашивает «ну как там?» о сделанном. Лично, кто бы автор ни был: это его
 * собственная задача, а не новость для команды. Себе не пишем.
 */
async function notifyAuthorClosed(
  task: TaskNotice & { createdById: string | null },
  actor: string,
  log: Log,
): Promise<void> {
  if (!task.createdById) return;
  const author = await prisma.user.findUnique({
    where: { id: task.createdById },
    select: { telegramChatId: true, disabledAt: true },
  });
  const chatId = author?.telegramChatId;
  if (!chatId || author.disabledAt || !isPrivateChat(chatId)) return;

  const done = task.status === "done";
  const text = [
    `${done ? "✅" : "✖️"} <b>${escapeHtml(task.title)}</b>`,
    `${done ? "Выполнено" : "Отменено"} · ${escapeHtml(actor)}`,
  ].join("\n");
  const files = await countFiles(task.parent?.id ?? task.id);
  await sendPrivate(chatId, text, log, taskKeyboard({ ...task, files }));
}
