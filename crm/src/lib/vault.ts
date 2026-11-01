/**
 * Старые пароли на мастер-фразе. Только для переноса.
 *
 * Новые пароли шифрует сервер, а эти лежат в колонке `secret`, зашифрованные в
 * браузере, и прочитать их может только тот, кто знает фразу. Поэтому переносит их
 * браузер: выводит ключ, расшифровывает и отправляет на сервер, а тот шифрует своим
 * ключом. Зашифровать здесь больше нечего, поэтому функций записи нет.
 *
 * Параметры менять нельзя: они вшиты в уже записанные шифротексты.
 */

const KDF_ITERATIONS = 600_000;
/** AES-GCM требует ровно 96 бит: больше не безопаснее, а совместимость хуже. */
const IV_BYTES = 12;

/**
 * Что шифруется в контрольное значение. Строка произвольная и не секретна:
 * важно лишь, что при верной фразе она расшифруется, а при неверной AES-GCM
 * не сойдётся по метке подлинности и бросит исключение.
 */
const VERIFIER_PLAINTEXT = "it-optimization-vault";

// Возвращаемый тип уточнён намеренно: WebCrypto принимает только буфер,
// подкреплённый обычным ArrayBuffer, а `new Uint8Array(n)` выводится шире.
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Мастер-фраза → ключ AES-GCM. Занимает около секунды и это норма: медленный
 * вывод ключа — единственное, что мешает перебирать фразу по утёкшему дампу.
 */
export async function deriveKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(salt),
      iterations: KDF_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

/**
 * Вход — base64 от `iv || ciphertext`. Бросает, если ключ не тот: у AES-GCM встроена
 * проверка подлинности.
 */
export async function decrypt(key: CryptoKey, packed: string): Promise<string> {
  const bytes = fromBase64(packed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
    key,
    bytes.slice(IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}

/**
 * Проверка фразы без участия сервера: он не знает ни фразы, ни ключа, поэтому
 * сказать «пароль неверный» может только тот, кто попробовал расшифровать.
 */
export async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    return (await decrypt(key, verifier)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}
