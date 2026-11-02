import type { Prisma } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/session.js";

/**
 * Кто что видит. Единственное место, где записано правило «сотрудник видит своё»:
 * маршруты, поиск, заметки и «Сегодня» стоят на этих функциях, а не на своих копиях
 * условия. Иначе первая же правка видимости разошлась бы между экранами, и запись,
 * закрытая в списке, нашлась бы поиском.
 *
 * Роль читается на каждом запросе, поэтому понижение действует сразу, без выхода.
 * Проверка стоит на сервере: скрытие в интерфейсе защищает от случайности, а не от
 * человека с консолью.
 */

export type Viewer = Pick<AuthenticatedUser, "id" | "role" | "memberName">;

export function isAdmin(viewer: Pick<Viewer, "role">): boolean {
  return viewer.role === "admin";
}

/**
 * Имя человека из команды, которым значится учётка. Берётся только из связи
 * `team_members.user_id`: первое слово имени больше не угадываем. Принимает и
 * вошедшего, и строку `users` с подгруженным `member`.
 */
export function memberNameOf(
  user: { memberName: string | null } | { member: { name: string } | null },
): string | null {
  return "memberName" in user ? user.memberName : (user.member?.name ?? null);
}

/**
 * Задачи, видимые человеку: он исполнитель, автор или исполнитель подзадачи. Подзадача
 * видна ещё и через родителя: иначе в открытой карточке были бы строки, которые не
 * открываются. Удалённая подзадача доступа не даёт.
 *
 * Автор считается только у задачи верхнего уровня. Подзадачу заводят внутри чужой
 * задачи, пока она видна: иначе снятый с неё человек сохранял бы подзадачу, а через неё
 * вписал бы себя обратно и снова открыл родителя с заметками и проект.
 *
 * Условие с OR внутри: подставлять его только через `AND: [taskScope(user)]`, рядом с
 * поиском простое разворачивание перезаписало бы одно OR другим.
 */
export function taskScope(viewer: Viewer): Prisma.TaskWhereInput {
  if (isAdmin(viewer)) return {};

  const author: Prisma.TaskWhereInput = { createdById: viewer.id, parentId: null };
  const member = memberNameOf(viewer);
  if (!member) return { OR: [author, { parent: author }] };

  const assigned: Prisma.TaskWhereInput = { developers: { has: member } };
  const onSubtask: Prisma.TaskWhereInput = {
    subtasks: { some: { deletedAt: null, ...assigned } },
  };
  return {
    OR: [author, assigned, onSubtask, { parent: { OR: [author, assigned, onSubtask] } }],
  };
}

/**
 * Живая задача. Мягкое удаление родителя подзадачи не трогает, поэтому её собственная
 * отметка пуста, но лежит она вместе с родителем в Корзине и вернётся вместе с ним. Без
 * этого условия она открывалась бы по прямому адресу, хотя её карточки уже нет.
 *
 * Условие с OR внутри, подставлять только через `AND`, как и `taskScope`.
 */
export const liveTask: Prisma.TaskWhereInput = {
  deletedAt: null,
  OR: [{ parentId: null }, { parent: { deletedAt: null } }],
};

/** Проекты, видимые человеку: он ведёт проект или у него есть в нём задача. */
export function projectScope(viewer: Viewer): Prisma.ProjectWhereInput {
  if (isAdmin(viewer)) return {};

  const hasTask: Prisma.ProjectWhereInput = {
    tasks: { some: { AND: [liveTask, taskScope(viewer)] } },
  };
  const member = memberNameOf(viewer);
  return member ? { OR: [{ developers: { has: member } }, hasTask] } : hasTask;
}
