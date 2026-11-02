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
 * Свой таймаут обязателен: у fetch в Node его нет вовсе, и одно зависшее
 * соединение остановило бы опрос обновлений навсегда. Для длинного опроса
 * значение передаётся отдельно — он держит соединение по 30 секунд намеренно.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export async function callBotApi<T>(
  method: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан");
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  const body = (await response.json()) as TelegramResponse<T>;
  if (!body.ok || body.result === undefined) {
    throw new TelegramError(
      body.error_code ?? response.status,
      body.description ?? `Telegram вернул ${response.status}`,
    );
  }
  return body.result;
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

export async function sendMessage(
  chatId: string,
  text: string,
  button?: LinkButton,
): Promise<void> {
  await callBotApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    // Ссылки на CRM разворачивать не во что — она за логином.
    link_preview_options: { is_disabled: true },
    ...(button && { reply_markup: { inline_keyboard: [[button]] } }),
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
  button?: LinkButton,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sendMessage(chatId, text, button);
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
