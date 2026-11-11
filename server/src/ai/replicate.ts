import { env } from "../env.js";

/**
 * Тонкая обёртка над HTTP API Replicate, как и над Bot API: нужен ровно один вызов —
 * запустить модель и дождаться ответа. Пакет `replicate` ради этого не нужен.
 *
 * Модели открытые: разбор делает языковая модель по имени (официальные модели Replicate
 * вызываются без версии), голос — Whisper по версии. Закрытые модели вроде Claude или GPT
 * не годятся: их владельцы не обслуживают компании из ряда стран, и посредник этого не
 * меняет.
 */

const API = "https://api.replicate.com/v1";

type Status = "starting" | "processing" | "succeeded" | "failed" | "canceled" | "aborted";

interface Prediction {
  id: string;
  status: Status;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

export class ReplicateError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ReplicateError";
  }

  /**
   * Ключ отозван, кончились деньги или модель сняли: повтор не поможет, нужен человек с
   * доступом к Replicate или к `server/.env`.
   */
  get needsOwner(): boolean {
    return [401, 402, 403, 404].includes(this.code);
  }

  /**
   * Сбой по дороге (0 — соединение или недочитанный ответ) или у самого Replicate: вторая
   * попытка почти всегда проходит. Истёкшее ожидание (408) сюда не входит: повтор удвоил
   * бы и без того долгое ожидание.
   */
  get transient(): boolean {
    return this.code === 0 || this.code === 429 || this.code >= 500;
  }
}

function isFinal(status: Status): boolean {
  return status !== "starting" && status !== "processing";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Свой таймаут обязателен, как и у телеграма: у fetch в Node его нет. Повторяется только
 * сбой соединения — ответ сервера, даже ошибочный, значит, что запрос дошёл, и повтор
 * запустил бы модель второй раз.
 */
async function call(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      if (attempt >= 3) {
        throw new ReplicateError(0, `Replicate недоступен: ${String(cause)}`);
      }
      await sleep(attempt * 1000);
    }
  }
}

async function readPrediction(response: Response): Promise<Prediction> {
  const body = (await response.json().catch(() => null)) as
    (Prediction & { detail?: string; title?: string }) | null;
  // Соединение оборвалось посреди ответа: запрос дошёл, но что вернулось — неизвестно.
  if (response.ok && !body) {
    throw new ReplicateError(0, "ответ Replicate не дочитался");
  }
  if (!response.ok || !body) {
    throw new ReplicateError(
      response.status,
      body?.detail ?? body?.title ?? `Replicate вернул ${response.status}`,
    );
  }
  return body;
}

/** Официальная модель по имени «владелец/имя» или любая другая по версии. */
export type Target = { model: string } | { version: string };

/**
 * Запуск и ожидание результата. Сначала держим запрос открытым (`Prefer: wait`): короткий
 * разбор возвращается в том же ответе. Не успела — опрашиваем раз в секунду. `Cancel-After`
 * снимает зависшее предсказание на стороне Replicate: иначе оно тикало бы за наш счёт и
 * после того, как мы перестали ждать.
 *
 * Сбой по дороге даёт ровно одну повторную попытку целиком. Если оборвался ответ на
 * запуск, первое предсказание доработает впустую: это доли цента, а человек иначе получил
 * бы «не получилось» на ровном месте.
 */
export async function runPrediction(
  target: Target,
  input: Record<string, unknown>,
  deadlineMs: number,
): Promise<unknown> {
  try {
    return await runOnce(target, input, deadlineMs);
  } catch (cause) {
    if (!(cause instanceof ReplicateError) || !cause.transient) throw cause;
    return runOnce(target, input, deadlineMs);
  }
}

async function runOnce(
  target: Target,
  input: Record<string, unknown>,
  deadlineMs: number,
): Promise<unknown> {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("REPLICATE_API_TOKEN не задан");

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const deadline = Date.now() + deadlineMs;
  const seconds = Math.ceil(deadlineMs / 1000);

  const [url, body] =
    "model" in target
      ? [`${API}/models/${target.model}/predictions`, { input }]
      : [`${API}/predictions`, { version: target.version, input }];

  let prediction = await readPrediction(
    await call(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: `wait=${Math.min(seconds, 30)}`,
          "Cancel-After": `${seconds}s`,
        },
        body: JSON.stringify(body),
      },
      45_000,
    ),
  );

  while (!isFinal(prediction.status)) {
    if (Date.now() > deadline) {
      throw new ReplicateError(408, "модель не ответила вовремя");
    }
    await sleep(1000);
    prediction = await readPrediction(
      await call(
        prediction.urls?.get ?? `${API}/predictions/${prediction.id}`,
        { headers },
        15_000,
      ),
    );
  }

  if (prediction.status !== "succeeded") {
    throw new ReplicateError(
      500,
      `предсказание ${prediction.status}: ${String(prediction.error)}`,
    );
  }
  return prediction.output;
}

/**
 * Ответ языковой модели. Такие модели отдают поток кусков текста, а по HTTP он приходит
 * массивом строк. Температура низкая: нужен разбор, а не сочинение, и одинаковое сообщение
 * должно давать одинаковую задачу.
 */
export async function complete(prompt: string, maxTokens: number): Promise<string> {
  const output = await runPrediction(
    { model: env.REPLICATE_LLM_MODEL },
    { prompt, max_tokens: maxTokens, temperature: 0.1 },
    60_000,
  );
  return Array.isArray(output) ? output.join("") : String(output ?? "");
}

/**
 * Голос в текст. Язык задан, а не определяется сам: на коротком сообщении автоопределение
 * путает русский с украинским и болгарским. `hint` — имена команды и проектов: Whisper
 * пишет их так, как увидел в подсказке, а не «Камилю» как «Камелю».
 *
 * Файл уходит в теле запроса (data URI). Replicate советует так передавать файлы до 1 МБ:
 * голосовое в телеграме — это около 6 минут речи.
 */
export async function transcribe(
  audio: Buffer,
  mime: string,
  hint: string,
): Promise<string> {
  const output = (await runPrediction(
    { version: env.REPLICATE_WHISPER_VERSION },
    {
      audio: `data:${mime};base64,${audio.toString("base64")}`,
      language: "ru",
      transcription: "plain text",
      initial_prompt: hint,
    },
    120_000,
  )) as { transcription?: string } | null;
  return output?.transcription?.trim() ?? "";
}
