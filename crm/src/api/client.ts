/**
 * Единственная точка выхода в сеть. Все запросы идут с `credentials: include`:
 * авторизация держится на httpOnly-куке, которую API выписывает на общий домен
 * `.it-optimization.ru`, — токенов в localStorage здесь нет намеренно.
 */

const BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

if (!BASE) {
  throw new Error("VITE_API_URL не задан — скопируй crm/.env.example в crm/.env.local");
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Причина отказа, на которую реагирует интерфейс. Текст — только для человека. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Сессия кончилась или её отозвали — форма входа реагирует именно на это. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  // Файл уходит как есть: границу частей в Content-Type браузер ставит сам.
  const form = body instanceof FormData;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...rest,
      credentials: "include",
      headers: {
        ...(body === undefined || form ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
  } catch {
    // fetch падает только на сетевом уровне: API недоступен или нет интернета.
    throw new ApiError(0, "Сервер не отвечает. Проверь соединение.");
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const body =
      payload && typeof payload === "object"
        ? (payload as { error?: unknown; code?: unknown })
        : {};
    const code = typeof body.code === "string" ? body.code : undefined;
    // Отказ по лимиту пишет плагин, и по-английски. Свои 429 приходят с `code`.
    const message =
      response.status === 429 && !code
        ? "Слишком много попыток. Подождите несколько минут"
        : body.error !== undefined
          ? String(body.error)
          : `Ошибка ${response.status}`;
    throw new ApiError(response.status, message, code);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form }),
};

/**
 * Полный адрес в API — для того, что грузит сам браузер: картинки и ссылки на файлы. Кука
 * уходит и с ними: API и CRM на одном сайте, а кука выписана на общий домен.
 */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}
