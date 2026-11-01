import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP по RFC 6238 на `node:crypto`. Сорок строк вместо пакета: алгоритм закрыт
 * стандартом и не меняется, а зависимость пришлось бы обновлять годами.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;
const DIGITS = 6;
/** ±1 шаг: часы телефона расходятся с сервером, а человек набирает не мгновенно. */
const WINDOW = 1;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/=+$/, "")) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Некорректный base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function generateSecret(): Buffer {
  return randomBytes(20);
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

/** Шаг, которому соответствует код, или null. Формат кода проверен снаружи: /^\d{6}$/. */
export function matchStep(secret: Buffer, code: string, now = Date.now()): number | null {
  const step = currentStep(now);
  const given = Buffer.from(code);
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step + delta)), given)) {
      return step + delta;
    }
  }
  return null;
}

export function otpauthUri(secretBase32: string, email: string): string {
  const issuer = "IT-Optimization CRM";
  const label = encodeURIComponent(`${issuer}:${email}`);
  const query = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  // URLSearchParams кодирует пробел плюсом, а часть приложений показывает его буквально.
  return `otpauth://totp/${label}?${query.toString().replaceAll("+", "%20")}`;
}
