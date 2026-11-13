import http from "node:http";
import https from "node:https";
import { env } from "../env.js";

/**
 * Тонкая обёртка над Bot API. Библиотеки вроде grammy или telegraf здесь
 * избыточны: нужны ровно два метода — отправить сообщение и забрать обновления,
 * а зависимость пришлось бы обновлять годами ради этого.
 */

/** Адрес Bot API — настраиваемый, см. TELEGRAM_API_BASE в env.ts. */
const API = env.TELEGRAM_API_BASE.replace(/\/$/, "");

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "TelegramError";
  }

  /**
   * Пользователь заблокировал бота или удалил чат. Это не сбой: адресат просто
   * больше не хочет сообщений, и его привязку надо снять, а не повторять
   * отправку до бесконечности.
   */
  get isGone(): boolean {
    return this.code === 403 || this.code === 400;
  }
}

/**
 * Свой таймаут обязателен: одно зависшее соединение остановило бы опрос обновлений
 * навсегда. Для длинного опроса значение передаётся отдельно — он держит соединение по 30
 * секунд намеренно.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Соединения с телеграмом живут долго и переиспользуются. С VPS телеграм доступен только
 * через туннель (`tg-tunnel`), и новое соединение там дорогое: канал SSH, TCP до
 * телеграма и TLS поверх всего этого, а именно новые соединения когда-то и зависали. У
 * `fetch` в Node простаивающее соединение закрывается через 4 секунды, и почти каждое
 * нажатие кнопки открывало новое. Здесь простой держится до `IDLE_MS`, а `keepWarm` не
 * даёт последнему свободному соединению остыть.
 *
 * Опрос обновлений ходит своим агентом: иначе он забирал бы себе только что
 * освободившееся тёплое соединение, а обработчик пришедшего нажатия открывал бы новое.
 */
const IDLE_MS = 60_000;
const target = new URL(API);
const transport = target.protocol === "http:" ? http : https;
const agent = new transport.Agent({
  keepAlive: true,
  timeout: IDLE_MS,
  scheduling: "lifo",
});
const pollAgent = new transport.Agent({ keepAlive: true, timeout: IDLE_MS });

interface SlowLog {
  warn: (obj: unknown, msg: string) => void;
}

/** Куда писать о медленных вызовах: по ним видно, тормозит ли туннель. */
let slowLog: SlowLog | null = null;
export function setTelegramLog(log: SlowLog): void {
  slowLog = log;
}

/** Дольше этого вызов телеграма считается медленным и попадает в журнал. */
const SLOW_MS = 1_000;
let lastCallAt = 0;

/** Ответ и то, шёл ли запрос по уже открытому соединению. */
function post(
  path: string,
  body: string,
  signal: AbortSignal,
  poll: boolean,
): Promise<{ status: number; text: string; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path,
        method: "POST",
        agent: poll ? pollAgent : agent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            reused: request.reusedSocket,
          }),
        );
      },
    );
    request.on("error", (cause) =>
      reject(Object.assign(cause, { reusedSocket: request.reusedSocket })),
    );
    request.end(body);
  });
}

/**
 * Телеграм мог закрыть простаивавшее соединение ровно в тот момент, когда по нему ушёл
 * запрос. Такой обрыв повторяется один раз уже по новому соединению: запрос до сервера не
 * дошёл, двойной отправки не будет.
 */
function staleSocket(cause: unknown): boolean {
  const error = cause as { reusedSocket?: boolean; code?: string; name?: string };
  return (
    error.reusedSocket === true &&
    error.name !== "AbortError" &&
    ["ECONNRESET", "EPIPE", "ECONNABORTED"].includes(error.code ?? "")
  );
}

export async function callBotApi<T>(
  method: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан");
  }

  const poll = method === "getUpdates";
  if (!poll) lastCallAt = Date.now();
  const path = `${target.pathname.replace(/\/$/, "")}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const body = JSON.stringify(payload);
  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const started = Date.now();

  let response: Awaited<ReturnType<typeof post>>;
  try {
    response = await post(path, body, abort, poll);
  } catch (cause) {
    if (!staleSocket(cause)) throw cause;
    response = await post(path, body, abort, poll);
  }

  const took = Date.now() - started;
  if (!poll && took > SLOW_MS) {
    slowLog?.warn(
      { method, ms: took, reused: response.reused },
      "телеграм ответил медленно",
    );
  }

  let parsed: TelegramResponse<T> | null = null;
  try {
    parsed = JSON.parse(response.text) as TelegramResponse<T>;
  } catch {
    // Не JSON — значит, ответил не Bot API, а что-то по дороге: ошибка ниже скажет код.
  }
  if (!parsed?.ok || parsed.result === undefined) {
    throw new TelegramError(
      parsed?.error_code ?? response.status,
      parsed?.description ?? `Telegram вернул ${response.status}`,
    );
  }
  return parsed.result;
}

/**
 * Держит два соединения тёплыми: если бот какое-то время молчал, два лёгких `getMe`
 * разом. Два, потому что нажатие кнопки — это ответ на нажатие и правка сообщения
 * одновременно, и второе иначе ждало бы нового соединения через туннель.
 */
const WARM_EVERY_MS = 20_000;
export function keepWarm(): () => void {
  const timer = setInterval(() => {
    if (Date.now() - lastCallAt < WARM_EVERY_MS) return;
    for (let i = 0; i < 2; i += 1) void callBotApi("getMe").catch(() => {});
  }, WARM_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Экранирование под parse_mode=HTML. Телеграм понимает всего три опасных
 * символа, и своё имя клиента — «ООО "Рога & Копыта" <главный>» — сломает
 * разметку без этого.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Телеграм не принимает текст длиннее 4096 символов, а его ошибку 400 код читает как
 * «чат недоступен»: сообщение молча пропало бы как раз тогда, когда в нём больше всего.
 */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Режем по строкам, а не по символам: каждая строка сама закрывает свои теги, и
 * обрезка посреди строки дала бы ту же ошибку 400. Срезается низ сообщения, `tail`
 * получает число отрезанных строк.
 */
export function fitMessage(lines: string[], tail: (dropped: number) => string): string {
  const text = lines.join("\n").trimEnd();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;

  const kept: string[] = [];
  // Хвост с самым большим числом: настоящий не длиннее его.
  let length = tail(lines.length).length;
  for (const line of lines) {
    length += line.length + 1;
    if (length > MAX_MESSAGE_LENGTH) break;
    kept.push(line);
  }
  return [...kept, tail(lines.length - kept.length)].join("\n");
}

/** Кнопка-ссылка под сообщением. */
export interface LinkButton {
  text: string;
  url: string;
}

/** Под сообщением: одна кнопка-ссылка или целая клавиатура с действиями. */
export type Markup = LinkButton | Keyboard;

export async function sendMessage(
  chatId: string,
  text: string,
  markup?: Markup,
): Promise<void> {
  await callBotApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    // Ссылки на CRM разворачивать не во что — она за логином.
    link_preview_options: { is_disabled: true },
    ...(markup && {
      reply_markup: { inline_keyboard: Array.isArray(markup) ? markup : [[markup]] },
    }),
  });
}

/**
 * Отправка, которая не роняет вызывающий код: уведомление — не транзакция.
 *
 * Повторы нужны не для красоты: из российских сетей api.telegram.org отвечает
 * с задержками в десяток секунд и рвёт часть соединений. Одной попытки мало —
 * без повторов утренний дайджест терялся бы через раз.
 */
export async function trySendMessage(
  chatId: string,
  text: string,
  log: { warn: (obj: unknown, msg: string) => void },
  attempts = 3,
  markup?: Markup,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendMessage(chatId, text, markup);
      return true;
    } catch (cause) {
      // Заблокировал бота или удалил чат — повторять бессмысленно, ответ не
      // изменится. Пробрасываем наверх: там снимут привязку.
      if (cause instanceof TelegramError && cause.isGone) throw cause;

      if (attempt === attempts) {
        log.warn({ err: cause, chatId }, "не удалось отправить сообщение в телеграм");
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  return false;
}

/** Кнопка под сообщением: ссылка или действие, которое бот получит обратно. */
export type InlineButton = LinkButton | { text: string; callback_data: string };
export type Keyboard = InlineButton[][];

/**
 * Отправка с номером сообщения: карточку задачи потом правят на месте, когда нажимают
 * «Отменить» или меняют исполнителя. `replyTo` привязывает ответ к сообщению, из которого
 * он сделан: в общем чате иначе непонятно, чья это задача.
 */
export async function postMessage(
  chatId: string,
  text: string,
  options: {
    keyboard?: Keyboard;
    replyTo?: number;
    /**
     * Открыть у человека ответ на это сообщение, с подсказкой в поле ввода. В группе ответ
     * на сообщение бота доходит до него и при включённой приватности. `selective` — только
     * у упомянутых в тексте, а не у всего чата.
     */
    forceReply?: string;
  } = {},
): Promise<number> {
  const message = await callBotApi<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(options.keyboard && { reply_markup: { inline_keyboard: options.keyboard } }),
    ...(options.forceReply && {
      reply_markup: {
        force_reply: true,
        selective: true,
        input_field_placeholder: options.forceReply.slice(0, 64),
      },
    }),
    ...(options.replyTo && {
      reply_parameters: {
        message_id: options.replyTo,
        allow_sending_without_reply: true,
      },
    }),
  });
  return message.message_id;
}

export async function editMessage(
  chatId: string,
  messageId: number,
  text: string,
  keyboard: Keyboard = [],
): Promise<void> {
  try {
    await callBotApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (cause) {
    // Тот же текст с теми же кнопками телеграм считает ошибкой, хотя всё уже как надо:
    // так бывает при двойном нажатии.
    if (cause instanceof TelegramError && /not modified/i.test(cause.message)) return;
    throw cause;
  }
}

/** «Печатает…» в шапке чата на несколько секунд: видно, что бот занят ответом. */
export async function sendTyping(chatId: string): Promise<void> {
  await callBotApi("sendChatAction", { chat_id: chatId, action: "typing" });
}

/**
 * Без ответа на нажатие кнопка крутит часики ещё полминуты. Ответ не бросает: он только
 * гасит часики, и его сбой («нажатие устарело») не должен отменять правку сообщения,
 * которая идёт рядом с ним.
 */
export async function answerCallback(id: string, text?: string): Promise<void> {
  await callBotApi("answerCallbackQuery", {
    callback_query_id: id,
    ...(text && { text }),
  }).catch(() => {});
}

/**
 * Список команд в меню бота (кнопка «Меню» у поля ввода). Область — личные чаты или
 * группы: в группе свои команды и чужие подсказки там только мешают.
 */
export async function setMyCommands(
  commands: { command: string; description: string }[],
  scope: "all_private_chats" | "all_group_chats",
): Promise<void> {
  await callBotApi("setMyCommands", { commands, scope: { type: scope } });
}

export async function getMe(): Promise<{ id: number; username?: string }> {
  return callBotApi("getMe");
}

/**
 * Файл из сообщения, например голосовое. Адрес скачивания содержит токен бота, поэтому
 * он не попадает ни в журнал, ни в текст ошибки, и наружу файл уходит только байтами.
 */
export async function downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
  const file = await callBotApi<{ file_path?: string; file_size?: number }>("getFile", {
    file_id: fileId,
  });
  if (!file.file_path) throw new Error("телеграм не отдал путь к файлу");
  if (file.file_size && file.file_size > maxBytes)
    throw new Error("файл слишком большой");

  const response = await fetch(
    `${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok) throw new Error(`файл не скачался: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("файл слишком большой");
  return bytes;
}

/**
 * То немногое из Bot API, что читает бот. Поля, которые не нужны, не описаны: телеграм
 * присылает их десятками.
 */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TgFile {
  file_id: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

/** Откуда переслано. Неизвестный тип тоже бывает: телеграм добавляет их без спроса. */
export type TgOrigin =
  | { type: "user"; sender_user: TgUser }
  | { type: "hidden_user"; sender_user_name: string }
  | { type: "chat"; sender_chat: { title?: string } }
  | { type: "channel"; chat: { title?: string } };

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
  entities?: TgEntity[];
  caption?: string;
  caption_entities?: TgEntity[];
  voice?: TgFile;
  audio?: TgFile;
  video_note?: TgFile;
  video?: TgFile;
  photo?: TgFile[];
  document?: TgFile;
  forward_origin?: TgOrigin;
  reply_to_message?: TgMessage;
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_markup?: { inline_keyboard?: { callback_data?: string }[][] };
  };
  data?: string;
}
