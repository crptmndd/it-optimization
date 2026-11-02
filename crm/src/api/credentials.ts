import { api } from "./client";
import type { Currency } from "@/lib/money";

/**
 * Справочник учёток сервисов.
 *
 * Пароль сюда не приходит ни в каком виде: списки и карточки его не отдают. Открыть
 * его можно только через `revealCredential`, с кодом 2FA, и каждый просмотр пишется в
 * журнал. Записывается он открытым текстом по HTTPS, шифрует сервер.
 */
export interface Credential {
  id: string;
  service: string;
  login: string | null;
  url: string | null;
  owner: string | null;
  /** Проект, к которому относится доступ. `null` — общий для всей команды. */
  project: { id: string; title: string } | null;
  /** Пароль сохранён и открывается через `revealCredential`. */
  hasPassword: boolean;
  /** Есть старый пароль на мастер-фразе, который ещё не перенесён. */
  legacyPending: boolean;
  renewsAt: string | null;
  /**
   * Минорные единицы. Валюта — в `currency`, период — в `monthlyFee`.
   *
   * Проверять на наличие надо нестрого (`!= null`): CRM выкатывается сразу при
   * пуше, а API руками, поэтому новое поле какое-то время приходит как undefined —
   * и строгое `!== null` пропустит его дальше, где оно уронит рендер.
   */
  amountMinor: number | null;
  currency: Currency;
  monthlyFee: boolean;
  notes: string | null;
  /** Когда запись закрепил текущий пользователь. Набор у каждого свой. */
  pinnedAt: string | null;
}

export interface CredentialInput {
  service?: string;
  login?: string | null;
  url?: string | null;
  owner?: string | null;
  projectId?: string | null;
  /** Строка — новый пароль, `null` — стереть, поля нет — не менять. */
  password?: string | null;
  renewsAt?: string | null;
  amountMinor?: number | null;
  currency?: Currency;
  monthlyFee?: boolean;
  notes?: string | null;
}

export async function listCredentials(search?: string): Promise<Credential[]> {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  const { credentials } = await api.get<{ credentials: Credential[] }>(
    `/credentials${query}`,
  );
  return credentials;
}

export async function createCredential(input: CredentialInput): Promise<Credential> {
  const { credential } = await api.post<{ credential: Credential }>(
    "/credentials",
    input,
  );
  return credential;
}

export async function updateCredential(
  id: string,
  input: CredentialInput,
): Promise<Credential> {
  const { credential } = await api.patch<{ credential: Credential }>(
    `/credentials/${id}`,
    input,
  );
  return credential;
}

export async function deleteCredential(id: string): Promise<void> {
  await api.delete<void>(`/credentials/${id}`);
}

export async function pinCredential(id: string): Promise<string> {
  const { pinnedAt } = await api.put<{ pinnedAt: string }>(`/credentials/${id}/pin`);
  return pinnedAt;
}

export async function unpinCredential(id: string): Promise<void> {
  await api.delete<void>(`/credentials/${id}/pin`);
}

export interface RevealedPassword {
  /** `null` — пароля у записи нет: его стёрли в другой вкладке. */
  password: string | null;
  confirmedUntil: string;
}

/** Код нужен, только если у сессии нет открытого окна подтверждения. */
export async function revealCredential(
  id: string,
  code?: string,
): Promise<RevealedPassword> {
  return api.post<RevealedPassword>(`/credentials/${id}/reveal`, { code });
}

export interface LegacySecret {
  id: string;
  service: string;
  /** Шифротекст на мастер-фразе: расшифровывает браузер, см. `lib/vault.ts`. */
  secret: string;
}

export async function readLegacySecrets(code?: string): Promise<LegacySecret[]> {
  const { items } = await api.post<{ items: LegacySecret[] }>("/credentials/legacy", {
    code,
  });
  return items;
}

export interface MigrationResult {
  migrated: number;
  skipped: number;
}

export async function migrateSecrets(
  items: { id: string; password: string }[],
  code?: string,
): Promise<MigrationResult> {
  return api.post<MigrationResult>("/credentials/migrate", { items, code });
}
