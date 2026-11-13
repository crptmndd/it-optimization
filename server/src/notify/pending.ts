import { z } from "zod";
import { ReplicateError } from "../ai/replicate.js";
import { auditAs } from "../audit.js";
import { createNote, NOTE_MAX_LENGTH } from "../crm/notes.js";
import { reachableTask, updateTask } from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { canIntake, env } from "../env.js";
import { attachFiles, filesOf } from "./intake/files.js";
import { askModel, dateBlock, dueFrom } from "./intake/parse.js";
import { afterTaskUpdate } from "./after-update.js";
import { isPrivateChat } from "./notifications.js";
import { refreshTaskMessage, type ViewKind } from "./task-view.js";
import { teamUserOf, type TeamUser } from "./team-user.js";
import { escapeHtml, postMessage, type TgMessage } from "./telegram.js";
import { formatDate, zonedNow } from "./zone.js";

/**
 * Кнопки, которым мало нажатия: «📅 Изменить срок» ждёт срок словами («к пятнице», «до
 * ноября»), «📎 Прикрепить файл» — скриншот или файл. Бот задаёт вопрос, а следующее
 * сообщение этого человека в этом чате — ответ на него, а не новая задача.
 *
 * Ожидание живёт в памяти десять минут: перезапуск сервера его сбрасывает, и человек
 * просто нажмёт кнопку ещё раз. В общем чате ответом считается только ответ на вопрос
 * бота: иначе случайная реплика в чате стала бы сроком, а скриншот для другого — файлом
 * задачи. В личке — любое следующее сообщение. Команда (`/tasks`) ожидание снимает.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

/** Срок, файл, а из меню «✏️ Редактировать» — новое название и описание. */
type Kind = "due" | "file" | "title" | "note";

interface Pending {
  kind: Kind;
  taskId: string;
  chatId: string;
  telegramId: number;
  /** Сообщение о задаче, которое обновится в прежнем виде, когда ответ придёт. */
  source: { messageId: number; view: ViewKind };
  /** Вопрос бота: в общем чате ответом считается только ответ на него. */
  promptId: number;
  expiresAt: number;
  /** Сколько файлов уже легло: альбом приходит несколькими сообщениями. */
  saved: number;
  problems: string[];
  /** Сообщение без файла уже получило напоминание: второе снимает ожидание. */
  reminded: boolean;
  confirm?: NodeJS.Timeout;
}

const WAIT_MS = 10 * 60_000;
/** Альбом приходит пачкой за секунду: подтверждение ждёт, пока она закончится. */
const ALBUM_QUIET_MS = 2_000;

const waiting = new Map<string, Pending>();

function keyOf(chatId: string, telegramId: number): string {
  return `${chatId}:${telegramId}`;
}

const CANCEL = /^(отмена|отменить|отмени|не надо|стоп|cancel)$/i;

export async function askForInput(input: {
  kind: Kind;
  taskId: string;
  chatId: string;
  telegramId: number;
  name: string;
  source: Pending["source"];
}): Promise<void> {
  const { kind, chatId } = input;
  const group = !isPrivateChat(chatId);
  // `selective` открывает ответ только у упомянутых, поэтому в общем чате зовём по имени.
  const who = group
    ? `<a href="tg://user?id=${input.telegramId}">${escapeHtml(input.name)}</a>, `
    : "";
  const how = group ? "ответьте на это сообщение" : "напишите";
  const reply = group ? " ответом на это сообщение" : "";
  // В общем чате фраза начинается с имени, поэтому первая буква вопроса строчная.
  const cap = (word: string) => (group ? word : word[0]!.toUpperCase() + word.slice(1));
  const prompts: Record<Kind, { text: string; placeholder: string }> = {
    due: {
      text: `📅 ${who}${cap("когда")} срок? Просто ${how}: «к пятнице», «до 1 декабря», «через неделю» или «без срока».`,
      placeholder: "к пятнице, до 1 декабря…",
    },
    file: {
      text: `📎 ${who}${cap("пришлите")} скриншот или файл${reply} — прикреплю к задаче.`,
      placeholder: "Скриншот или файл",
    },
    title: {
      text: `✏️ ${who}${cap("как")} назвать задачу? Напишите новое название${reply}.`,
      placeholder: "Новое название",
    },
    note: {
      text: `💬 ${who}${cap("напишите")} описание${reply} — оно встанет в задачу и в уведомление о ней.`,
      placeholder: "Что сделать, ссылки, детали",
    },
  };

  const promptId = await postMessage(chatId, prompts[kind].text, {
    replyTo: input.source.messageId,
    forceReply: prompts[kind].placeholder,
  });

  const key = keyOf(chatId, input.telegramId);
  clearTimeout(waiting.get(key)?.confirm);
  waiting.set(key, {
    kind,
    taskId: input.taskId,
    chatId,
    telegramId: input.telegramId,
    source: input.source,
    promptId,
    expiresAt: Date.now() + WAIT_MS,
    saved: 0,
    problems: [],
    reminded: false,
  });
}

/**
 * Сообщение — ответ на вопрос бота? Тогда оно разобрано здесь и дальше не идёт: иначе
 * «до ноября» в личке стало бы новой задачей. `false` — сообщение обычное.
 */
export async function consumePending(message: TgMessage, log: Log): Promise<boolean> {
  const from = message.from;
  if (!from || from.is_bot) return false;
  const chatId = String(message.chat.id);
  const key = keyOf(chatId, from.id);
  const pending = waiting.get(key);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    waiting.delete(key);
    return false;
  }
  if (
    !isPrivateChat(chatId) &&
    message.reply_to_message?.message_id !== pending.promptId
  ) {
    return false;
  }

  const text = (message.text ?? message.caption ?? "").trim();
  if (text.startsWith("/")) {
    waiting.delete(key);
    return false;
  }

  const files = filesOf([message], null);
  if (files.length === 0 && CANCEL.test(text)) {
    waiting.delete(key);
    await postMessage(chatId, "Хорошо, ничего не меняю.", {
      replyTo: message.message_id,
    });
    return true;
  }

  const user = await teamUserOf(from.id);
  if (!user) {
    waiting.delete(key);
    return false;
  }

  if (pending.kind === "file") return consumeFile(pending, message, files, user, log);
  if (pending.kind === "title" || pending.kind === "note") {
    return consumeText(pending, message, text, user, log);
  }
  return consumeDue(pending, message, text, user, log);
}

/**
 * Новое название — правкой задачи, как в CRM. Описание — заметкой: «Подробностей» в
 * задаче больше нет, а последняя заметка и есть то, что видно в карточке и уведомлении.
 */
async function consumeText(
  pending: Pending,
  message: TgMessage,
  text: string,
  user: TeamUser,
  log: Log,
): Promise<boolean> {
  const key = keyOf(pending.chatId, pending.telegramId);
  const say = (reply: string) =>
    postMessage(pending.chatId, reply, { replyTo: message.message_id });
  if (!text) {
    await say(
      pending.kind === "title"
        ? "Напишите название текстом."
        : "Напишите описание текстом.",
    );
    return true;
  }
  waiting.delete(key);

  let footer: string;
  // Ответ «готово» уходит вместе с перерисовкой, а не перед ней: каждый — путь до телеграма.
  let said: Promise<unknown>;
  if (pending.kind === "title") {
    const title = text.slice(0, 300);
    const result = await updateTask(user.viewer, pending.taskId, { title });
    if (!result.ok) {
      await say(result.code === 404 ? "Эта задача вам недоступна." : result.error);
      return true;
    }
    await auditAs(
      user.viewer.id,
      {
        entity: "tasks",
        entityId: pending.taskId,
        action: "update",
        diff: { via: "telegram", fields: ["title"] },
      },
      log,
    );
    said = say(`✏️ Название: ${escapeHtml(title)}`);
    footer = `✏️ Название изменено · ${escapeHtml(user.name)}`;
  } else {
    const task = await prisma.task.findFirst({
      where: reachableTask(pending.taskId, user.viewer),
      select: { id: true, parentId: true, title: true },
    });
    if (!task) {
      await say("Эта задача вам недоступна.");
      return true;
    }
    // У подзадачи своего окна нет: её описание встаёт заметкой к родителю.
    const body = task.parentId ? `К подзадаче «${task.title}»: ${text}` : text;
    await createNote(
      "task",
      task.parentId ?? task.id,
      user.viewer.id,
      body.slice(0, NOTE_MAX_LENGTH),
    );
    said = say("💬 Описание добавлено");
    footer = `💬 Описание обновлено · ${escapeHtml(user.name)}`;
  }

  await Promise.all([
    said,
    refreshTaskMessage({
      chatId: pending.chatId,
      ...pending.source,
      taskId: pending.taskId,
      footer,
    }).catch((cause: unknown) =>
      log.warn({ err: cause }, "сообщение о задаче не обновилось"),
    ),
  ]);
  return true;
}

async function consumeFile(
  pending: Pending,
  message: TgMessage,
  files: ReturnType<typeof filesOf>,
  user: TeamUser,
  log: Log,
): Promise<boolean> {
  const key = keyOf(pending.chatId, pending.telegramId);
  if (files.length === 0) {
    // Один раз напоминаем, на второе сообщение без файла — отпускаем: человек передумал.
    if (pending.reminded) {
      waiting.delete(key);
      return false;
    }
    pending.reminded = true;
    await postMessage(
      pending.chatId,
      "Жду скриншот или файл. Передумали — напишите «отмена».",
      { replyTo: message.message_id },
    );
    return true;
  }

  const task = await prisma.task.findFirst({
    where: reachableTask(pending.taskId, user.viewer),
    select: { id: true, parentId: true, title: true },
  });
  if (!task) {
    waiting.delete(key);
    await postMessage(pending.chatId, "Эта задача вам недоступна.", {
      replyTo: message.message_id,
    });
    return true;
  }

  // Файлы подзадачи видны в окне родителя: своего окна у неё нет.
  const result = await attachFiles(task.parentId ?? task.id, files, user.viewer.id, log);
  pending.saved += result.saved;
  pending.problems.push(...result.problems);
  pending.expiresAt = Date.now() + WAIT_MS;

  clearTimeout(pending.confirm);
  pending.confirm = setTimeout(() => {
    void finishFiles(pending, task.title, user, message.message_id, log).catch(
      (cause: unknown) => log.warn({ err: cause }, "подтверждение файлов не отправлено"),
    );
  }, ALBUM_QUIET_MS);
  return true;
}

async function finishFiles(
  pending: Pending,
  title: string,
  user: TeamUser,
  replyTo: number,
  log: Log,
): Promise<void> {
  const key = keyOf(pending.chatId, pending.telegramId);
  if (waiting.get(key) === pending) waiting.delete(key);

  const lines =
    pending.saved > 0
      ? [`📎 Прикреплено к «${escapeHtml(title)}»: ${pending.saved}`]
      : [];
  lines.push(...pending.problems.map((problem) => `⚠️ ${escapeHtml(problem)}`));
  await Promise.all([
    lines.length > 0
      ? postMessage(pending.chatId, lines.join("\n"), { replyTo })
      : undefined,
    pending.saved > 0
      ? refreshTaskMessage({
          chatId: pending.chatId,
          ...pending.source,
          taskId: pending.taskId,
          footer: `📎 Прикреплён файл · ${escapeHtml(user.name)}`,
        }).catch((cause: unknown) =>
          log.warn({ err: cause }, "сообщение о задаче не обновилось"),
        )
      : undefined,
  ]);
}

async function consumeDue(
  pending: Pending,
  message: TgMessage,
  text: string,
  user: TeamUser,
  log: Log,
): Promise<boolean> {
  const key = keyOf(pending.chatId, pending.telegramId);
  const say = (reply: string) =>
    postMessage(pending.chatId, reply, { replyTo: message.message_id });

  if (!text) {
    await say(
      "Напишите срок текстом: «к пятнице», «до 1 декабря», «25.11» или «без срока».",
    );
    return true;
  }

  const current = await prisma.task.findFirst({
    where: reachableTask(pending.taskId, user.viewer),
    select: { dueAt: true },
  });
  if (!current) {
    waiting.delete(key);
    await say("Эта задача вам недоступна.");
    return true;
  }

  let due: Date | null | undefined | typeof PAST;
  try {
    due = await parseDue(text, current.dueAt);
  } catch (cause) {
    log.warn({ err: cause }, "срок не разобран");
    due = undefined;
    if (cause instanceof ReplicateError && cause.needsOwner) {
      await say("Разбор слов сейчас недоступен. Напишите дату цифрами: «25.11».");
      return true;
    }
  }
  if (due === undefined || due === PAST) {
    // Ожидание остаётся: человек напишет иначе.
    pending.expiresAt = Date.now() + WAIT_MS;
    await say(
      due === PAST
        ? "Эта дата уже прошла. Напишите срок впереди: «до 1 декабря», «через неделю»."
        : "Не понял срок. Напишите иначе: «к пятнице», «до 1 декабря», «через неделю», «25.11» или «без срока».",
    );
    return true;
  }

  waiting.delete(key);
  const result = await updateTask(user.viewer, pending.taskId, { dueAt: due });
  if (!result.ok) {
    await say(result.code === 404 ? "Эта задача вам недоступна." : result.error);
    return true;
  }
  await auditAs(
    user.viewer.id,
    {
      entity: "tasks",
      entityId: pending.taskId,
      action: "update",
      diff: { via: "telegram", dueAt: due ? due.toISOString() : null },
    },
    log,
  );
  afterTaskUpdate(
    {
      existing: result.existing,
      task: result.task,
      actor: { id: user.viewer.id, name: user.name },
      source: { chatId: pending.chatId, messageId: pending.source.messageId },
    },
    log,
  );

  const line = due ? `📅 Срок: ${formatDate(due, env.TIMEZONE)}` : "📅 Срок снят";
  await Promise.all([
    say(line),
    refreshTaskMessage({
      chatId: pending.chatId,
      ...pending.source,
      taskId: pending.taskId,
      footer: `${line} · ${escapeHtml(user.name)}`,
    }).catch((cause: unknown) =>
      log.warn({ err: cause }, "сообщение о задаче не обновилось"),
    ),
  ]);
  return true;
}

/** День через `days` от сегодняшнего, строкой ГГГГ-ММ-ДД. */
function shift(today: string, days: number): string {
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/**
 * Срок словами → момент конца дня в поясе команды. `null` — срок снять, `undefined` —
 * не понял. Частые формы («завтра», «25.11», «без срока») разбираются сразу, без модели:
 * так быстрее и работает без Replicate. Остальное («до ноября», «через две недели») —
 * моделью, и её ответ проверяет `dueFrom`: дата настоящая, не в прошлом, не дальше двух лет.
 */
export async function parseDue(
  text: string,
  current: Date | null,
): Promise<Date | null | undefined | typeof PAST> {
  const today = zonedNow(env.TIMEZONE).date;
  const phrase = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[.!]+$/, "")
    .trim();

  if (
    /^(без срока|нет срока|без даты|убери(те)? срок|сними(те)? срок|срок не нужен)$/.test(
      phrase,
    )
  ) {
    return null;
  }
  const relative: Record<string, number> = { сегодня: 0, завтра: 1, послезавтра: 2 };
  if (phrase in relative)
    return dueFrom(shift(today, relative[phrase]!), today) ?? undefined;

  const numeric = phrase.match(
    /^(?:до |к |на )?(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/,
  );
  if (numeric) {
    const [, day, month, rawYear] = numeric;
    const thisYear = Number(today.slice(0, 4));
    const pad = (value: string) => value.padStart(2, "0");
    let year = rawYear
      ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
      : thisYear;
    let value = `${year}-${pad(month!)}-${pad(day!)}`;
    // Без года и уже прошло — значит, следующего года: «25.01», сказанное в ноябре.
    if (!rawYear && value < today) {
      year += 1;
      value = `${year}-${pad(month!)}-${pad(day!)}`;
    }
    return dueFrom(value, today) ?? undefined;
  }

  if (!canIntake) return undefined;
  const answer = await askModel(
    buildDuePrompt(today, current, text),
    z.object({ due: z.string().nullish() }),
    100,
  );
  if (answer.due === "none") return null;
  // Модель поняла, но дата позади: «до ноября», сказанное в ноябре. Это не «не понял».
  if (answer.due && /^\d{4}-\d{2}-\d{2}$/.test(answer.due) && answer.due < today) {
    return PAST;
  }
  return dueFrom(answer.due, today) ?? undefined;
}

/** Срок понят, но уже прошёл: человеку нужен другой ответ, чем «не понял». */
export const PAST = "past" as const;

function buildDuePrompt(today: string, current: Date | null, text: string): string {
  return [
    "Ты переводишь срок задачи из слов человека в дату.",
    "",
    ...dateBlock(today),
    `Текущий срок задачи: ${current ? formatDate(current, env.TIMEZONE) : "нет"}.`,
    "",
    "Слова:",
    '"""',
    text.replace(/"""/g, '"'),
    '"""',
    "",
    'Верни только JSON без пояснений: {"due":"ГГГГ-ММ-ДД"} — последний день, когда задача должна быть сделана; {"due":"none"} — если просят убрать срок; {"due":null} — если это не срок.',
    "",
    "Правила:",
    "- «до <месяца>» — последний день предыдущего месяца: «до ноября» → 31 октября. «до конца <месяца>», «в <месяце>», «к концу <месяца>» — последний день этого месяца.",
    "- «к <дню>», «до <дня>», «в <день недели>», «до <числа>» — сам этот день. День недели — ближайший будущий, не сегодняшний.",
    "- «через N дней (недель, месяцев)» — от сегодняшней даты.",
    "- «на этой неделе», «в конце недели» — пятница этой недели; «на следующей неделе» — пятница следующей.",
    "- «до конца года» — 31 декабря.",
    "- «перенеси на N дней», «сдвинь на неделю» — текущий срок плюс столько; срока нет — от сегодня.",
    "- Месяц или число, которые в этом году уже прошли, — следующего года. Дата не раньше сегодняшней.",
  ].join("\n");
}
