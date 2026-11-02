import { useEffect, useState } from "react";
import { listHandles } from "@/api/team";

/**
 * Telegram-ники исполнителей для подсказок в формах. Один запрос на вкладку: ники
 * меняются раз в полгода, а форма открывается десятки раз в день.
 */
let cached: Promise<Map<string, string | null>> | null = null;

function load(): Promise<Map<string, string | null>> {
  cached ??= listHandles()
    .then((rows) => new Map(rows.map((row) => [row.name, row.telegramUsername])))
    .catch((cause: unknown) => {
      cached = null;
      throw cause;
    });
  return cached;
}

/** После сохранения в Настройках следующая форма должна видеть новые ники. */
export function forgetHandles(): void {
  cached = null;
}

/**
 * `null`, пока неизвестно: тогда форма молчит, а не пугает «ника нет» человека, у
 * которого ник есть.
 */
export function useHandles(): Map<string, string | null> | null {
  const [handles, setHandles] = useState<Map<string, string | null> | null>(null);

  useEffect(() => {
    let alive = true;
    load()
      .then((next) => alive && setHandles(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return handles;
}
