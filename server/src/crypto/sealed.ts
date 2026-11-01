import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { env } from "../env.js";

/**
 * Шифрование на сервере: пароли сервисов и секреты 2FA.
 *
 * Ключ живёт только в окружении, поэтому дамп базы, который каждую ночь уезжает с
 * машины, без него ничего не раскрывает. Его потеря значит потерю всего, что им
 * зашифровано: перешифровать нечем, ключ постоянный.
 *
 * AAD привязывает шифротекст к строке: `totp:<userId>`, `credential:<id>`. Без него
 * человек с доступом к базе мог бы перенести шифротекст чужой записи к себе и
 * прочитать его через обычный просмотр.
 */

const key = env.VAULT_KEY ? Buffer.from(env.VAULT_KEY, "base64") : null;

export const canVault = key !== null;

/** v1.<base64 от iv(12) || tag(16) || шифротекст>. Версия — на случай смены формата. */
export function seal(plaintext: string, aad: string): string {
  if (!key) throw new Error("VAULT_KEY не задан");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

/** Бросает при чужом ключе, чужом aad или порче: у GCM встроена проверка подлинности. */
export function open(packed: string, aad: string): string {
  if (!key) throw new Error("VAULT_KEY не задан");
  if (!packed.startsWith("v1.")) throw new Error("Неизвестный формат шифротекста");
  const raw = Buffer.from(packed.slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * Сверка ключа при старте. Падать нельзя: остальное API должно работать и с чужим
 * ключом. Но молчать тоже нельзя: опечатка вскрылась бы только на просмотре, а новые
 * пароли тем временем ложились бы под чужой ключ, и в базе оказалось бы два поколения
 * шифротекста.
 */
export async function checkVaultKey(log: {
  error: (obj: unknown, msg: string) => void;
}): Promise<void> {
  if (!canVault) return;

  const [credential, user] = await Promise.all([
    prisma.credential.findFirst({
      where: { passwordEnc: { not: null } },
      select: { id: true, passwordEnc: true },
    }),
    prisma.user.findFirst({
      where: { totpSecretEnc: { not: null } },
      select: { id: true, totpSecretEnc: true },
    }),
  ]);

  try {
    if (credential?.passwordEnc) {
      open(credential.passwordEnc, `credential:${credential.id}`);
    }
    if (user?.totpSecretEnc) open(user.totpSecretEnc, `totp:${user.id}`);
  } catch {
    log.error({}, "VAULT_KEY не подходит к записям в базе: пароли и 2FA не откроются");
  }
}
