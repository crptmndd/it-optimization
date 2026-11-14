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
  created_at?: string;
  started_at?: string;
  metrics?: { predict_time?: number };
}

interface ModelLog {
  warn: (obj: unknown, msg: string) => void;
}

/** Куда писать о долгих ответах модели: по ним видно, тормозит ли разбор сообщений. */
let modelLog: ModelLog | null = null;
export function setModelLog(log: ModelLog): void {
  modelLog = log;
}

/**
 * Дольше этого ответ модели попадает в журнал вместе с разбивкой: сколько предсказание
 * ждало в очереди Replicate и сколько считалось. Очередь — это холодный старт или нехватка
 * мощностей у Replicate, счёт — длина ответа и скорость самой модели.
 */
const SLOW_MODEL_MS = 4_000;

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
    return [401, 402, 403].includes(this.code) || this.modelGone;
  }

  /**
   * Модели больше нет на Replicate: 404, 410 или 422 «This deployment is currently
   * disabled… has been deprecated». Так в ноябре 2026 сняли Qwen3 235B, и каждое сообщение
   * падало, пока модель не заменили руками. Такую модель `complete` пропускает и берёт
   * следующую.
   */
  get modelGone(): boolean {
    return (
      this.code === 404 ||
      this.code === 410 ||
      (this.code === 422 && /deprecat|disabled|no longer available/i.test(this.message))
    );
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
 * Сбой по дороге (обрыв, 429, 5xx) даёт повторные попытки целиком — `attempts` всего, с
 * паузой перед каждой: две мгновенные попытки подряд обычно ловят одну и ту же заминку
 * Replicate. Повтор идёт без `Prefer: wait`, обычным запуском с опросом: 502 на голосовое
 * в ноябре 2026 пришёл именно на синхронное ожидание. Если оборвался ответ на запуск,
 * первое предсказание доработает впустую: это доли цента, а человек иначе получил бы «не
 * получилось» на ровном месте.
 */
export async function runPrediction(
  target: Target,
  input: Record<string, unknown>,
  deadlineMs: number,
  attempts = 2,
): Promise<unknown> {
  const started = Date.now();
  const timing: Timing = {};
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runOnce(target, input, deadlineMs, timing, attempt === 1);
      } catch (cause) {
        if (
          !(cause instanceof ReplicateError) ||
          !cause.transient ||
          attempt >= attempts
        ) {
          throw cause;
        }
        await sleep(RETRY_PAUSE_MS[attempt - 1] ?? 4000);
      }
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > SLOW_MODEL_MS) {
      modelLog?.warn(
        { model: "model" in target ? target.model : "whisper", ms, ...timing },
        "модель отвечала долго",
      );
    }
  }
}

/** Разбивка предсказания: сколько ждало в очереди Replicate и сколько считалось. */
interface Timing {
  queueMs?: number;
  predictMs?: number;
}
function readTiming(prediction: Prediction, timing: Timing): void {
  const created = prediction.created_at ? Date.parse(prediction.created_at) : NaN;
  const begun = prediction.started_at ? Date.parse(prediction.started_at) : NaN;
  const predict = prediction.metrics?.predict_time;
  if (Number.isFinite(begun - created)) timing.queueMs = begun - created;
  if (typeof predict === "number") timing.predictMs = Math.round(predict * 1000);
}

/** Пауза перед второй и третьей попыткой. */
const RETRY_PAUSE_MS = [1500, 4000];

async function runOnce(
  target: Target,
  input: Record<string, unknown>,
  deadlineMs: number,
  timing: Timing,
  /** Держать ли запрос открытым до ответа (`Prefer: wait`), или запустить и опрашивать. */
  sync: boolean,
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
          ...(sync && { Prefer: `wait=${Math.min(seconds, 30)}` }),
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

  readTiming(prediction, timing);
  if (prediction.status !== "succeeded") {
    throw new ReplicateError(
      500,
      `предсказание ${prediction.status}: ${String(prediction.error)}`,
    );
  }
  return prediction.output;
}

/**
 * Модель на случай, если все из `REPLICATE_LLM_MODEL` сняли. Всегда стоит последней: тогда
 * устаревшее значение в `.env` не роняет разбор, а только пишет в журнал, что его пора
 * сменить.
 */
export const DEFAULT_LLM_MODEL = "moonshotai/kimi-k2.6";

/** Модели по порядку: из окружения через запятую, и последней — модель из кода. */
export function llmModels(setting = env.REPLICATE_LLM_MODEL): string[] {
  const listed = setting
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return [...new Set([...listed, DEFAULT_LLM_MODEL])];
}

/**
 * Снятые модели — до перезапуска API. Их не пробуют первыми, чтобы не тратить на отказ
 * каждый запрос, но и не выбрасывают: если снятыми окажутся все, честная ошибка лучше
 * пустоты.
 */
const gone = new Set<string>();

/**
 * Ответ языковой модели. Такие модели отдают поток кусков текста, а по HTTP он приходит
 * массивом строк. Температура низкая: нужен разбор, а не сочинение, и одинаковое сообщение
 * должно давать одинаковую задачу.
 *
 * Моделей может быть несколько. Снятая (`modelGone`) или упавшая на стороне Replicate
 * (5xx, обрыв) уступает место следующей. Отказ по ключу или деньгам (401–403) общий для
 * всех моделей, и пробовать дальше незачем. Истёкшее ожидание (408) тоже не передаётся
 * дальше: ещё минута на другой модели — это человек, который две минуты смотрит на
 * «Разбираю…».
 */
export async function complete(prompt: string, maxTokens: number): Promise<string> {
  const models = llmModels();
  const order = [
    ...models.filter((model) => !gone.has(model)),
    ...models.filter((model) => gone.has(model)),
  ];
  let failure: unknown;
  for (const [index, model] of order.entries()) {
    try {
      const output = await runPrediction(
        { model },
        { prompt, max_tokens: maxTokens, temperature: 0.1 },
        60_000,
      );
      return Array.isArray(output) ? output.join("") : String(output ?? "");
    } catch (cause) {
      failure = cause;
      const last = index === order.length - 1;
      if (!(cause instanceof ReplicateError) || last) break;
      if (cause.modelGone) {
        gone.add(model);
        modelLog?.warn(
          { model, reason: cause.message.slice(0, 200) },
          "модель снята с Replicate, беру следующую — поправьте REPLICATE_LLM_MODEL",
        );
        continue;
      }
      if (!cause.transient) break;
      modelLog?.warn(
        { model, reason: cause.message.slice(0, 200) },
        "модель не ответила, беру следующую",
      );
    }
  }
  throw failure;
}

/**
 * Голос в текст. Язык задан, а не определяется сам: на коротком сообщении автоопределение
 * путает русский с украинским и болгарским. `hint` — имена команды и проектов: Whisper
 * пишет их так, как увидел в подсказке, а не «Камилю» как «Камелю».
 *
 * Файл уходит в теле запроса (data URI). Replicate советует так передавать файлы до 1 МБ:
 * голосовое в телеграме — это около 6 минут речи.
 *
 * Сначала `openai/whisper` (три попытки с паузами), а если Replicate так и не ответила —
 * запасная сборка Whisper large-v3 на другом железе (`REPLICATE_WHISPER_FALLBACK_VERSION`,
 * `vaibhavs10/incredibly-fast-whisper`). В ноябре 2026 голосовое падало на 502 шлюза
 * Replicate дважды подряд, и человек получал «Не смог расшифровать голосовое». Подсказок
 * с именами запасная модель не принимает: имя она может написать с ошибкой, но модель
 * разбора всё равно сводит его к человеку из команды по основе слова. Отказ по ключу или
 * деньгам и истёкшее ожидание дальше не передаются: у запасной было бы то же самое.
 */
export async function transcribe(
  audio: Buffer,
  mime: string,
  hint: string,
): Promise<string> {
  const data = `data:${mime};base64,${audio.toString("base64")}`;
  try {
    const output = (await runPrediction(
      { version: env.REPLICATE_WHISPER_VERSION },
      { audio: data, language: "ru", transcription: "plain text", initial_prompt: hint },
      120_000,
      3,
    )) as { transcription?: string } | null;
    return output?.transcription?.trim() ?? "";
  } catch (cause) {
    const fallback = env.REPLICATE_WHISPER_FALLBACK_VERSION;
    const retryable =
      cause instanceof ReplicateError && (cause.transient || cause.modelGone);
    if (!fallback || !retryable) throw cause;
    modelLog?.warn(
      { reason: cause.message.slice(0, 200) },
      "Whisper не ответил, расшифровываю запасной моделью",
    );
    const output = (await runPrediction(
      { version: fallback },
      { audio: data, task: "transcribe", language: "russian" },
      120_000,
    )) as { text?: string } | null;
    return output?.text?.trim() ?? "";
  }
}
