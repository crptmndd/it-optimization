import { api } from "./client";
import type { Currency } from "@/lib/money";

/**
 * Справочник учёток сервисов вместе с паролями.
 *
 * `secret` приходит и уходит только зашифрованным: ключ выводится из
 * мастер-фразы в браузере (см. `lib/vault.ts`) и на сервер не передаётся.
 * Поэтому утечка ночного дампа отдаёт нечитаемый текст, а не все сервисы
 * разом.
 */
export interface Credential {
  id: string;
  service: string;
  login: string | null;
  url: string | null;
  owner: string | null;
  /** Проект, к которому относится доступ. `null` — общий для всей команды. */
  project: { id: string; title: string } | null;
  /**
   * Пароль, зашифрованный в браузере. Сервер хранит его непрозрачно и
   * расшифровать не может — ключа у него нет и не будет.
   */
  secret: string | null;
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
}

export interface CredentialInput {
  service?: string;
  login?: string | null;
  url?: string | null;
  owner?: string | null;
  projectId?: string | null;
  secret?: string | null;
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
