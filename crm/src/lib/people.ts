import { useEffect, useState } from "react";
import { listHandles, type TeamHandle } from "@/api/team";

/**
 * Люди команды: кто может значиться исполнителем проекта или задачи.
 *
 * Список живёт на сервере, а не в коде: новый сотрудник появляется в «Кто делает» без
 * правки и выката. Отсюда же ники для подсказок в формах.
 */
export type Person = TeamHandle;

/** Один запрос на вкладку: состав меняется редко, а форма открывается десятки раз в день. */
let cached: Promise<Person[]> | null = null;

function load(): Promise<Person[]> {
  cached ??= listHandles().catch((cause: unknown) => {
    cached = null;
    throw cause;
  });
  return cached;
}

/** После изменений в Настройках следующая форма должна видеть новый состав и ники. */
export function forgetPeople(): void {
  cached = null;
}

/**
 * `null`, пока неизвестно: тогда форма молчит, а не пугает «ника нет» человека, у
 * которого ник есть.
 */
export function usePeople(): Person[] | null {
  const [people, setPeople] = useState<Person[] | null>(null);

  useEffect(() => {
    let alive = true;
    load()
      .then((next) => alive && setPeople(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return people;
}

/**
 * Кого предлагать в выборе. Вошедший первым: себе задачи ставят чаще всего. Назначить
 * можно только действующего, но уже выбранный остаётся в списке, даже если его учётку
 * отключили: иначе снять его с задачи было бы негде.
 */
export function pickablePeople(
  people: Person[] | null,
  me: string | null,
  picked: readonly string[],
): string[] {
  const active = (people ?? [])
    .filter((person) => person.active)
    .map((person) => person.name);
  const others = active.filter((name) => name !== me);
  const ordered = me && active.includes(me) ? [me, ...others] : others;
  return [...ordered, ...picked.filter((name) => !active.includes(name))];
}
