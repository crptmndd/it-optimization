import { ReplicateError, transcribe } from "../../ai/replicate.js";
import { auditAs } from "../../audit.js";
import { liveTask, taskScope } from "../../crm/access.js";
import { createNote, NOTE_MAX_LENGTH } from "../../crm/notes.js";
import { OPEN_TASK_STATUSES } from "../../crm/tasks/dto.js";
import { createTask } from "../../crm/tasks/service.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { isPrivateChat } from "../notifications.js";
import { teamUserOf, type TeamUser } from "../team-user.js";
import {
  downloadFile,
  editMessage,
  sendTyping,
  escapeHtml,
  postMessage,
  type Keyboard,
  type TgFile,
  type TgMessage,
  type TgUser,
} from "../telegram.js";
import {
  cardTaskId,
  flushNotices,
  loadCardTask,
  renderCard,
  scheduleNotice,
  type Log,
} from "./cards.js";
import { answerQuestion, rememberQuestion } from "../questions.js";
import { attachFiles, filesOf } from "./files.js";
import { handleTaskReply } from "./reply.js";
import {
  fallbackTask,
  loadContext,
  planTasks,
  speechHint,
  type IntakeContext,
  type Plan,
  type PlannedTask,
} from "./parse.js";

/**
 * Задачи из сообщений. В личке бот разбирает всё, что ему пишут, пересылают или
 * наговаривают. В общем чате — только обращённое к нему: `/task`, упоминание или ответ на
 * его карточку. Остальная переписка чата его не касается, даже если телеграм её присылает.
 *
 * Сообщения одного человека собираются в пачку: пересылка с подписью приходит в телеграм
 * несколькими сообщениями подряд, а задача из неё одна. Подпись бывает и после пересылки,
 * поэтому пачка из одних пересланных ждёт её дольше.
 */

/**
 * Тишина, после которой пачка уходит в разбор. Подпись с пересылкой и альбом телеграм
 * присылает почти разом, доли секунды, а каждая лишняя секунда здесь — секунда до карточки.
 */
const QUIET_MS = 1_200;
/** Пачка без своих слов автора — одни пересланные: ждём, вдруг подпишет. */
const QUIET_FORWARD_MS = 12_000;
/** Дольше пачку не держим, сколько бы ни приходило. */
const MAX_WAIT_MS = 20_000;
const MAX_MESSAGES = 20;
/** Одновременных разборов: каждый — деньги на Replicate, очередь их ограничивает. */
const MAX_JOBS = 3;
/** Голосовое до 1 МБ — около шести минут речи. Больше Replicate советует не слать в теле. */
const MAX_AUDIO_BYTES = 1_000_000;
/** Длинная переписка обрезается: модели хватает начала, а платим за каждый символ. */
const MAX_SOURCE = 8_000;

let identity: { id: number; username: string } | null = null;

/** Кто такой бот: нужно, чтобы узнать обращение к нему в общем чате. */
export function setIdentity(me: { id: number; username?: string }): void {
  identity = { id: me.id, username: me.username ?? "" };
}

const TASK_COMMAND = /^\/task(?:@(\w+))?(?:\s|$)/i;

/** `/task` — команда разбора, а не одна из служебных `/today`, `/start`. */
export function isTaskCommand(text: string | undefined): boolean {
  const match = text?.trim().match(TASK_COMMAND);
  if (!match) return false;
  return !match[1] || match[1].toLowerCase() === identity?.username.toLowerCase();
}

function wordsOf(message: TgMessage): string {
  return message.text ?? message.caption ?? "";
}

function mentionsBot(message: TgMessage): boolean {
  if (!identity?.username) return false;
  return wordsOf(message).toLowerCase().includes(`@${identity.username.toLowerCase()}`);
}

/**
 * Обращение к боту в общем чате. Ответ засчитывается только на карточку задачи: ответ на
 * утреннюю сводку («ок, спасибо») — не поручение, и разбирать его незачем.
 */
function isAddressed(message: TgMessage): boolean {
  if (isTaskCommand(message.text) || mentionsBot(message)) return true;
  const reply = message.reply_to_message;
  return Boolean(
    reply && identity && reply.from?.id === identity.id && cardTaskId(reply.reply_markup),
  );
}

/** В сообщении есть что разбирать. Стикер или опрос — нет. */
function hasContent(message: TgMessage): boolean {
  return Boolean(
    message.text ||
    message.caption ||
    message.voice ||
    message.audio ||
    message.video_note ||
    message.forward_origin ||
    message.photo ||
    message.document ||
    message.video,
  );
}

interface Bundle {
  chatId: string;
  fromId: number;
  messages: TgMessage[];
  timer?: NodeJS.Timeout;
  firstAt: number;
}

const bundles = new Map<string, Bundle>();

function keyOf(chatId: string, fromId: number): string {
  return `${chatId}:${fromId}`;
}

/**
 * Берёт ли бот это сообщение в разбор. В общем чате продолжение пачки принимается и без
 * обращения: подпись к пересылке пишут один раз, а пересланное идёт следом.
 */
export function acceptsMessage(message: TgMessage): boolean {
  if (!message.from || message.from.is_bot || !hasContent(message)) return false;
  const chatId = String(message.chat.id);
  if (isPrivateChat(chatId)) return true;
  if (chatId !== env.TELEGRAM_TEAM_CHAT_ID) return false;
  return isAddressed(message) || bundles.has(keyOf(chatId, message.from.id));
}

let active = 0;
const waiting: (() => void)[] = [];

async function withSlot(job: () => Promise<void>): Promise<void> {
  if (active >= MAX_JOBS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    await job();
  } finally {
    // Место передаётся следующему из очереди, а не освобождается: иначе между
    // освобождением и его стартом влез бы новый разбор сверх потолка.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

function repliesToTask(message: TgMessage): boolean {
  const reply = message.reply_to_message;
  return Boolean(
    reply && identity && reply.from?.id === identity.id && cardTaskId(reply.reply_markup),
  );
}

function ownWords(bundle: Bundle): boolean {
  return bundle.messages.some(
    (message) =>
      !message.forward_origin && (wordsOf(message) || message.voice || message.audio),
  );
}

export function acceptMessage(message: TgMessage, log: Log): void {
  const fromId = message.from!.id;
  const chatId = String(message.chat.id);
  const key = keyOf(chatId, fromId);

  let bundle = bundles.get(key);
  if (!bundle) {
    bundle = { chatId, fromId, messages: [], firstAt: Date.now() };
    bundles.set(key, bundle);
  }
  bundle.messages.push(message);
  clearTimeout(bundle.timer);

  // Ответ на сообщение о задаче подписи не ждёт: скриншот в ответ — уже законченная мысль.
  const quiet =
    ownWords(bundle) || bundle.messages.some(repliesToTask) ? QUIET_MS : QUIET_FORWARD_MS;
  const wait =
    bundle.messages.length >= MAX_MESSAGES
      ? 0
      : Math.max(0, Math.min(quiet, bundle.firstAt + MAX_WAIT_MS - Date.now()));

  const ready = bundle;
  ready.timer = setTimeout(() => {
    bundles.delete(key);
    void withSlot(() => processBundle(ready, log)).catch((cause: unknown) => {
      log.error({ err: cause }, "разбор сообщения в задачу сорвался");
    });
  }, wait);
}

/** Остановка: начатые пачки бросаем (их немного и они свежие), уведомления досылаем. */
export async function stopIntake(): Promise<void> {
  for (const bundle of bundles.values()) clearTimeout(bundle.timer);
  bundles.clear();
  await flushNotices();
}

function fullName(user: TgUser | undefined): string {
  if (!user) return "кого-то";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || (user.username ? `@${user.username}` : "кого-то");
}

function originOf(message: TgMessage): string | null {
  const origin = message.forward_origin;
  if (!origin) return null;
  switch (origin.type) {
    case "user":
      return fullName(origin.sender_user);
    case "hidden_user":
      return origin.sender_user_name;
    case "chat":
      return origin.sender_chat.title ?? "чата";
    case "channel":
      return origin.chat.title ?? "канала";
    default:
      return "неизвестного отправителя";
  }
}

/**
 * Текст со ссылками. Ссылка под словом («вот макет») приходит отдельно от текста, и без
 * неё исполнитель получил бы слово без адреса. Смещения телеграма — в UTF-16, как и
 * индексы строк в JS, поэтому режутся напрямую.
 */
function textOf(message: TgMessage): string {
  const text = wordsOf(message);
  const entities = (message.entities ?? message.caption_entities ?? [])
    .filter((entity) => entity.type === "text_link" && entity.url)
    .sort((a, b) => b.offset - a.offset);
  let result = text;
  for (const link of entities) {
    const end = link.offset + link.length;
    result = `${result.slice(0, end)} (${link.url})${result.slice(end)}`;
  }

  if (identity?.username) {
    result = result.replace(new RegExp(`@${identity.username}\\b`, "gi"), "");
  }
  return result.replace(TASK_COMMAND, "").trim();
}

function attachmentsOf(message: TgMessage): string[] {
  const marks: string[] = [];
  if (message.photo) marks.push("[фото]");
  if (message.video) marks.push("[видео]");
  if (message.document)
    marks.push(`[файл «${message.document.file_name ?? "без имени"}»]`);
  return marks;
}

class AudioTooLong extends Error {}

async function transcribeFile(file: TgFile, context: IntakeContext): Promise<string> {
  if (file.file_size && file.file_size > MAX_AUDIO_BYTES) throw new AudioTooLong();
  const bytes = await downloadFile(file.file_id, MAX_AUDIO_BYTES);
  return transcribe(bytes, file.mime_type ?? "audio/ogg", speechHint(context));
}

/**
 * Пачка → текст для модели. Каждое сообщение подписано: пересланное отделено от слов
 * автора, иначе модель приняла бы клиента, написавшего «сделайте до пятницы», за того,
 * кто ставит задачу.
 */
async function sourceOf(
  messages: TgMessage[],
  context: IntakeContext,
  log: Log,
): Promise<{
  text: string;
  plain: string;
  own: string;
  /** Расшифровки голосовых дословно: они ложатся в заметку задачи. */
  voice: string;
  problem: string | null;
}> {
  const blocks: string[] = [];
  const plain: string[] = [];
  /** Слова самого автора, без пересланного: из них задача, если модель не ответила. */
  const own: string[] = [];
  const voices: string[] = [];
  const problems: string[] = [];
  let words = false;

  // Ответ на чужое сообщение в общем чате — способ сказать «вот это — Камилю».
  const quoted = messages
    .map((message) => message.reply_to_message)
    .find((reply) => reply && reply.from?.id !== identity?.id && textOf(reply));
  if (quoted) {
    const from = originOf(quoted) ?? fullName(quoted.from);
    blocks.push(`Сообщение от ${from}, на которое отвечает автор:\n${textOf(quoted)}`);
    words = true;
  }

  for (const message of messages) {
    const parts: string[] = [];
    const spoken: string[] = [];
    const text = textOf(message);
    if (text) {
      parts.push(text);
      spoken.push(text);
    }

    const audio = message.voice ?? message.audio;
    if (audio) {
      try {
        const transcript = await transcribeFile(audio, context);
        if (transcript) {
          parts.push(`(голосом) ${transcript}`);
          spoken.push(transcript);
          voices.push(transcript);
        } else problems.push("В голосовом не разобрал слов.");
      } catch (cause) {
        if (cause instanceof AudioTooLong) {
          problems.push("Голосовое длиннее шести минут: такое не расшифровываю.");
        } else {
          if (cause instanceof ReplicateError && cause.needsOwner) throw cause;
          log.warn({ err: cause }, "голосовое не расшифровано");
          problems.push("Не смог расшифровать голосовое.");
        }
      }
    }
    if (message.video_note) problems.push("Кружки не разбираю: запишите голосовое.");

    if (parts.length > 0) words = true;
    parts.push(...attachmentsOf(message));
    if (parts.length === 0) continue;

    const origin = originOf(message);
    if (!origin) own.push(...spoken);
    const said = parts.join("\n");
    plain.push(origin ? `Переслано от ${origin}: ${said}` : said);
    blocks.push(
      `${origin ? `Переслано от ${origin}` : "Автор пишет"}:\n${parts.join("\n")}`,
    );
  }

  const text = blocks.join("\n\n");
  return {
    text: words ? text.slice(0, MAX_SOURCE) : "",
    plain: words ? plain.join("\n\n").slice(0, MAX_SOURCE) : "",
    own: own.join("\n").slice(0, MAX_SOURCE),
    voice: voices.join("\n\n"),
    problem: problems[0] ?? null,
  };
}

/**
 * Задача, на сообщение о которой ответили: уведомление, карточку или задачу из `/tasks`.
 * Ответ — это разговор о ней, а не новая задача: его разбирает `handleTaskReply`.
 */
function replyTargetOf(messages: TgMessage[]): string | null {
  for (const message of messages) {
    const reply = message.reply_to_message;
    if (!reply || !identity || reply.from?.id !== identity.id) continue;
    const id = cardTaskId(reply.reply_markup);
    if (id) return id;
  }
  return null;
}

/** Карточка, на которую ответили командой /task. У подзадачи берётся родитель. */
async function focusOf(messages: TgMessage[]): Promise<string | null> {
  for (const message of messages) {
    const reply = message.reply_to_message;
    if (!reply || !identity || reply.from?.id !== identity.id) continue;
    const id = cardTaskId(reply.reply_markup);
    if (!id) continue;
    const task = await prisma.task.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (task) return task.parentId ?? id;
  }
  return null;
}

/**
 * Ответ в чат: первый заменяет «Разбираю…», остальные идут новыми сообщениями. Заглушка
 * приходит обещанием: разбор не ждёт, пока она дойдёт до телеграма, а начинается сразу.
 */
function replier(chatId: string, replyTo: number, placeholder: Promise<number | null>) {
  let slot: Promise<number | null> | null = placeholder;
  /** Номер сообщения, где оказался ответ: по нему «Назад» найдёт заданный вопрос. */
  return async (text: string, keyboard?: Keyboard): Promise<number> => {
    const id = slot ? await slot : null;
    slot = null;
    if (id !== null) {
      try {
        await editMessage(chatId, id, text, keyboard);
        return id;
      } catch {
        // «Разбираю…» могли удалить: тогда просто новое сообщение.
      }
    }
    return postMessage(chatId, text, { keyboard, replyTo });
  };
}

const NOT_LINKED =
  "Задачи ставит только команда. Подключите бота: CRM → Настройки → «Подключить телеграм».";
const NO_TASK =
  "Не вижу здесь поручения. Напишите, что сделать и кому, например: «Фиксы по кошельку Камилю до пятницы».";
const FAILED =
  "Не получилось разобрать сообщение. Попробуйте ещё раз или поставьте задачу в CRM.";
const NO_AI =
  "Разбор сообщений сейчас недоступен: у Replicate закончились деньги, отозван ключ или снята модель. Задачу можно поставить в CRM.";
const FALLBACK =
  "Модель не разобрала сообщение, поэтому задача поставлена из текста как есть: проверьте название, исполнителя и срок.";
const NO_AI_FALLBACK =
  "Разбор моделью недоступен (у Replicate закончились деньги, отозван ключ или снята модель), поэтому задача поставлена из текста как есть.";

async function processBundle(bundle: Bundle, log: Log): Promise<void> {
  const messages = [...bundle.messages].sort((a, b) => a.message_id - b.message_id);
  const anchor = messages.find(isAddressed) ?? messages[0]!;
  const command = messages.some((message) => isTaskCommand(message.text));
  const target = command ? null : replyTargetOf(messages);
  const author = await teamUserOf(bundle.fromId);
  if (!author) {
    // На «ок» под уведомлением в общем чате от того, кто не подключил бота, молчим.
    const explicit =
      isPrivateChat(bundle.chatId) || command || messages.some(mentionsBot);
    if (!explicit) return;
    await postMessage(bundle.chatId, NOT_LINKED, { replyTo: anchor.message_id }).catch(
      (cause: unknown) => log.warn({ err: cause }, "ответ боту не отправлен"),
    );
    return;
  }

  if (target) {
    await processReply(bundle, messages, anchor, author, target, log);
    return;
  }

  const voice = messages.some((message) => message.voice || message.audio);
  const placeholder = postMessage(bundle.chatId, voice ? "⏳ Слушаю…" : "⏳ Разбираю…", {
    replyTo: anchor.message_id,
  }).catch(() => null);
  const say = replier(bundle.chatId, anchor.message_id, placeholder);

  try {
    const context = await loadContext(
      author.viewer,
      author.viewer.memberName,
      await focusOf(messages),
    );
    const source = await sourceOf(messages, context, log);
    if (!source.text) {
      await say(
        source.problem ?? "Не нашёл, что поставить: пришлите текст или голосовое.",
      );
      return;
    }

    let plan: Plan;
    /** Пометка на карточке, если задача поставлена без модели. */
    let degraded: string | null = null;
    try {
      plan = await planTasks(context, source.text);
    } catch (cause) {
      // Модель не ответила, ответила не то или Replicate недоступен: поручение не должно
      // пропасть. Задача ставится из текста как есть, а вопрос («что у Вадима?»)
      // задачей не становится — на него честно отвечаем, что не вышло.
      const owner = cause instanceof ReplicateError && cause.needsOwner;
      const asked = /\?\s*$/.test(source.own || source.plain);
      const task = asked ? null : fallbackTask(source.own, source.plain, context);
      if (!task) throw cause;
      log.error(
        { err: cause },
        owner
          ? "Replicate отказал в доступе, задача поставлена из текста"
          : "разбор сообщения сорвался, задача поставлена из текста",
      );
      plan = { intent: "task", tasks: [task] };
      degraded = owner ? NO_AI_FALLBACK : FALLBACK;
    }
    if (plan.intent === "question") {
      // В общем чате ответ увидели бы все, а собран он по правам спросившего.
      if (!isPrivateChat(bundle.chatId)) {
        await say("На вопросы о задачах я отвечаю в личном чате.");
        return;
      }
      const answer = await answerQuestion(author.viewer, plan.query);
      const messageId = await say(answer.text, answer.keyboard);
      rememberQuestion(bundle.chatId, messageId, plan.query);
      return;
    }

    const plans = plan.tasks.map((task) =>
      withTranscript(
        task,
        source.voice,
        messages.some((message) => textOf(message)),
      ),
    );
    if (plans.length === 0) {
      await say(NO_TASK);
      return;
    }

    for (const [index, plan] of plans.entries()) {
      const outcome = await createFromPlan(author, plan, log);
      if (!outcome.ok) {
        await say(
          `⚠️ Не поставил «${escapeHtml(plan.title)}»: ${escapeHtml(outcome.error)}`,
        );
        continue;
      }
      const extras = [...outcome.warnings];
      if (index === 0) {
        if (degraded) extras.push(`⚠️ ${degraded}`);
        if (source.problem) extras.push(`⚠️ ${source.problem}`);
        // Файлы — к первой задаче: в пачке почти всегда одна. У подзадачи своего окна нет,
        // и её файлы видны в окне родителя.
        const files = await attachFiles(
          plan.parentId ?? outcome.taskId,
          filesOf(messages, identity?.id ?? null),
          author.viewer.id,
          log,
        );
        extras.push(...files.problems.map((problem) => `⚠️ ${problem}`));
      }
      const task = await loadCardTask(outcome.taskId);
      if (!task) continue;
      // Никого не назвали или назвали не того — сразу список людей, а не кнопка к нему.
      const view = task.developers.length === 0 ? "people" : "main";
      const card = await renderCard(task, view, extras.map(escapeHtml));
      await say(card.text, card.keyboard);
    }
  } catch (cause) {
    const owner = cause instanceof ReplicateError && cause.needsOwner;
    log.error(
      { err: cause },
      owner ? "Replicate отказал в доступе" : "разбор сообщения сорвался",
    );
    await say(owner ? NO_AI : FAILED).catch(() => {});
  }
}

/**
 * Ответ на сообщение о задаче. «Разбираю…» не пишем: на простое «ок» бот промолчит, и
 * висящая заглушка осталась бы в чате. Вместо неё — «печатает…» в шапке чата.
 */
async function processReply(
  bundle: Bundle,
  messages: TgMessage[],
  anchor: TgMessage,
  author: TeamUser,
  taskId: string,
  log: Log,
): Promise<void> {
  await sendTyping(bundle.chatId).catch(() => {});
  try {
    const context = await loadContext(author.viewer, author.viewer.memberName, null);
    const source = await sourceOf(messages, context, log);
    const files = filesOf(messages, identity?.id ?? null);
    if (!source.text && files.length === 0) {
      if (source.problem) {
        await postMessage(bundle.chatId, source.problem, { replyTo: anchor.message_id });
      }
      return;
    }
    await handleTaskReply(
      {
        author,
        taskId,
        source: source.text,
        plain: source.plain,
        files,
        context,
        chatId: bundle.chatId,
        replyTo: anchor.message_id,
      },
      log,
    );
  } catch (cause) {
    const owner = cause instanceof ReplicateError && cause.needsOwner;
    log.error(
      { err: cause },
      owner ? "Replicate отказал в доступе" : "разбор ответа сорвался",
    );
    await postMessage(bundle.chatId, owner ? NO_AI : FAILED, {
      replyTo: anchor.message_id,
    }).catch(() => {});
  }
}

/**
 * Расшифровка голосового — в заметку задачи дословно. Модель пересказывает, а пересказ
 * теряет конкретику: из голосового про Threads вышла «социальная сеть», а «изучить
 * возможность» стало «создать». Голосовое в CRM не переслушать, так что расшифровка —
 * единственная запись того, что сказано. Если, кроме голоса, ничего не было, пересказ
 * модели не нужен: всё есть в расшифровке. Если был и текст, остаются оба. Подзадаче
 * заметка уходит к родителю, как и раньше.
 */
function withTranscript(task: PlannedTask, voice: string, hasText: boolean): PlannedTask {
  if (!voice.trim()) return task;
  const transcript = `🎙 Голосом, дословно: ${voice.trim()}`;
  const note = hasText && task.note ? `${task.note}\n\n${transcript}` : transcript;
  return {
    ...task,
    note:
      note.length <= NOTE_MAX_LENGTH ? note : `${note.slice(0, NOTE_MAX_LENGTH - 1)}…`,
  };
}

type Outcome =
  { ok: true; taskId: string; warnings: string[] } | { ok: false; error: string };

async function createFromPlan(
  author: TeamUser,
  plan: PlannedTask,
  log: Log,
): Promise<Outcome> {
  const { viewer } = author;
  const created = await createTask(viewer, {
    title: plan.title,
    // У подзадачи заметок не бывает: её детали уходят заметкой к родителю ниже.
    note: plan.parentId ? null : plan.note,
    developers: plan.developers,
    projectId: plan.parentId ? null : plan.projectId,
    parentId: plan.parentId,
    dueAt: plan.dueAt,
    priority: plan.priority,
  });
  if (!created.ok) return { ok: false, error: created.error };

  const { task } = created;
  const warnings: string[] = [];
  if (plan.unknown.length > 0) {
    warnings.push(`⚠️ Не нашёл в команде: ${plan.unknown.join(", ")}.`);
  }

  await auditAs(
    viewer.id,
    { entity: "tasks", entityId: task.id, action: "create", diff: { via: "telegram" } },
    log,
  );

  // Переслали то, что уже стоит в работе: задача заведена, но автор узнает о двойнике сразу,
  // а не на доске через неделю.
  if (!plan.parentId) {
    const twin = await prisma.task.count({
      where: {
        id: { not: task.id },
        parentId: null,
        title: { equals: plan.title, mode: "insensitive" },
        status: { in: [...OPEN_TASK_STATUSES] },
        AND: [liveTask, taskScope(viewer)],
      },
    });
    if (twin > 0)
      warnings.push(
        "⚠️ Открытая задача с таким названием уже есть. Если это она, отмените эту.",
      );
  }

  if (plan.parentId && plan.note) {
    const body = `К подзадаче «${plan.title}»: ${plan.note}`.slice(0, NOTE_MAX_LENGTH);
    await createNote("task", plan.parentId, viewer.id, body).catch((cause: unknown) => {
      log.warn({ err: cause }, "заметка к родителю не сохранилась");
      warnings.push("⚠️ Подробности не сохранились: у подзадачи нет заметок.");
    });
  }

  scheduleNotice({ taskId: task.id, author: viewer.memberName, skip: [] }, log);

  for (const sub of plan.subtasks) {
    const child = await createTask(viewer, {
      title: sub.title,
      parentId: task.id,
      developers: sub.developers,
    });
    if (!child.ok) {
      warnings.push(`⚠️ Подзадача «${sub.title}» не создана: ${child.error}.`);
      continue;
    }
    if (sub.unknown.length > 0) {
      warnings.push(`⚠️ В подзадаче «${sub.title}» не нашёл: ${sub.unknown.join(", ")}.`);
    }
    await auditAs(
      viewer.id,
      {
        entity: "tasks",
        entityId: child.task.id,
        action: "create",
        diff: { via: "telegram" },
      },
      log,
    );
    scheduleNotice(
      { taskId: child.task.id, author: viewer.memberName, skip: plan.developers },
      log,
    );
  }

  return { ok: true, taskId: task.id, warnings };
}
