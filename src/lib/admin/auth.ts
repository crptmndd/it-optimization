/**
 * Вход в панель.
 *
 * Панель умеет работать в двух режимах, и выбирает его переменная окружения:
 *
 *  - `api` — задан `NEXT_PUBLIC_ADMIN_API_URL`: вход по почте и паролю, сессия
 *    в httpOnly-куке, данные в PostgreSQL (см. server/ и docs/backend.md);
 *  - `github` — переменной нет: старый режим с личным токеном GitHub.
 *
 * Оба режима закрывают один и тот же интерфейс `CasesApi`, поэтому остальная
 * панель про этот выбор не знает.
 */

export const ADMIN_API_BASE = (process.env.NEXT_PUBLIC_ADMIN_API_URL ?? "").replace(
  /\/+$/,
  "",
);

export type AdminMode = "api" | "github";

export const ADMIN_MODE: AdminMode = ADMIN_API_BASE ? "api" : "github";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

/** Все запросы к API идут с кукой — без этого сессия не поедет. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ADMIN_API_BASE}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
  });
}

export async function readApiError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; problems?: string[] };
    if (body.problems?.length) return body.problems.join("; ");
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

/** Кто вошёл, или null. Используется при открытии панели. */
export async function fetchCurrentUser(): Promise<AdminUser | null> {
  const response = await apiFetch("/auth/me");
  if (!response.ok) return null;
  const body = (await response.json()) as { user: AdminUser };
  return body.user;
}

/** При включённой 2FA пароль сессию не создаёт: нужен код и этот билет. */
export type SignInResult = { user: AdminUser } | { ticket: string };

const TOO_MANY_ATTEMPTS = "Слишком много попыток входа. Подожди несколько минут.";

export async function signIn(email: string, password: string): Promise<SignInResult> {
  const response = await apiFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  // Ответ на превышение лимита пишет плагин, и по-английски.
  if (response.status === 429) throw new Error(TOO_MANY_ATTEMPTS);
  if (!response.ok) {
    throw new Error(await readApiError(response, "Не удалось войти"));
  }

  const body = (await response.json()) as
    { user: AdminUser } | { twoFactorRequired: true; ticket: string };
  return "user" in body ? { user: body.user } : { ticket: body.ticket };
}

/** Билет истёк или использован: форма возвращается к паролю. */
export class TicketExpiredError extends Error {}

/**
 * Второй шаг входа. Тело разбирается здесь, а не через `readApiError`: тот возвращает
 * только текст, а панели нужен `code`, чтобы отличить истёкший билет от неверного кода.
 */
export async function verifySecondFactor(
  ticket: string,
  code: string,
): Promise<AdminUser> {
  const response = await apiFetch("/auth/login/2fa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, code }),
  });

  const body = (await response.json().catch(() => null)) as {
    user?: AdminUser;
    error?: string;
    code?: string;
  } | null;

  if (response.ok && body?.user) return body.user;
  if (body?.code === "ticket_expired") {
    throw new TicketExpiredError(body.error ?? "Время на ввод кода вышло");
  }
  // Свой отказ по блокировке приходит с `code` и русским текстом, отказ плагина нет.
  if (response.status === 429 && !body?.code) throw new Error(TOO_MANY_ATTEMPTS);
  throw new Error(body?.error || "Не удалось войти");
}

export async function signOut(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}
