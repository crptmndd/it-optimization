import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Люди команды: кто может значиться исполнителем проекта или задачи.
 *
 * Имена, а не учётные записи: исполнитель — человек из команды, своя учётка у него
 * есть не всегда, а отключение учётки не должно стирать его из истории проектов.
 * Список закрытый, потому что свободная строка превращает «Вадим», «вадим» и «Вадик»
 * в трёх разных людей, и любая группировка по имени начинает врать.
 *
 * Список живёт в таблице `team_members`, а не в коде: новый сотрудник появляется в
 * «Кто делает» сразу, без правки и выката.
 */

/** Сколько человек ведут одну запись. Больше — почти наверняка ошибка запроса. */
export const MAX_DEVELOPERS = 10;

const UNKNOWN_DEVELOPER = "Неизвестный исполнитель";

/** Текст ошибки, если кого-то из названных нет в команде. */
export async function assertDevelopers(
  names: string[] | undefined,
): Promise<string | null> {
  if (!names || names.length === 0) return null;
  const unique = [...new Set(names)];
  const found = await prisma.teamMember.count({ where: { name: { in: unique } } });
  return found === unique.length ? null : UNKNOWN_DEVELOPER;
}

/**
 * Связать учётку с человеком, заведя его, если такого нет. Так новый сотрудник и
 * появляется в «Кто делает», и получает вход, если уже значился в задачах: Тимур есть
 * в команде, но учётки у него пока нет.
 *
 * Без учёта регистра: «тимур» в форме — это тот же Тимур, а не второй человек рядом с
 * ним. Условие `userId: null` стоит в самой записи, чтобы из двух одновременных
 * привязок прошла одна.
 *
 * `false` — человек уже связан с другой учёткой. Вызывающий обязан откатить транзакцию.
 */
export async function linkPerson(
  tx: Prisma.TransactionClient,
  input: { userId: string; name: string; telegramUsername?: string | null },
): Promise<boolean> {
  const { userId, name, telegramUsername } = input;

  const person = await tx.teamMember.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
  });
  if (!person) {
    await tx.teamMember.create({
      data: { name, userId, telegramUsername: telegramUsername || null },
    });
    return true;
  }

  const { count } = await tx.teamMember.updateMany({
    where: { name: person.name, userId: null },
    data: { userId, ...(telegramUsername && { telegramUsername }) },
  });
  return count > 0;
}
