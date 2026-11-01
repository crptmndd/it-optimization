import { api } from "./client";

/**
 * Параметры старого хранилища: нужны только для переноса паролей. Секретов здесь нет:
 * соль не секретна, а контрольное значение — шифротекст, который без мастер-фразы
 * бесполезен.
 */
export type VaultSettings =
  | { configured: false }
  | {
      configured: true;
      salt: string;
      verifier: string;
      /** Сколько старых паролей ещё не перенесено. */
      secrets: number;
    };

export async function getVault(): Promise<VaultSettings> {
  return api.get<VaultSettings>("/vault");
}
