import type { Prisma } from "@prisma/client";
import type { Viewer } from "../crm/access.js";
import { env } from "../env.js";
import type { TaskQuery } from "./intake/parse.js";
import {
  byUrgency,
  findTaskRows,
  renderTaskList,
  splitByDeadline,
  type TaskRow,
} from "./my-tasks.js";
import { escapeHtml, type Keyboard } from "./telegram.js";
import { startOfToday, startOfTomorrow } from "./zone.js";

/**
 * Вопросы о задачах обычным языком: «что у Вадима просрочено?», «что по кошельку?»,
 * «что я закрыл на этой неделе?». Модель только раскладывает вопрос по полям
 * (`TaskQuery`), а ответ собирает код из базы: так он не выдумывает задач и показывает
 * ровно то, что человек видит в CRM, — выборка идёт через `taskScope`.
 *
 * Только в личке: ответ в общем чате показал бы всем то, что видно спросившему.
 */

const DAY = 24 * 60 * 60 * 1000;

function shiftDays(date: Date, days: number): Date {
  // Сутки через календарь, а не 24 часами: на переходе времени они короче или длиннее.
  return startOfToday(
    env.TIMEZONE,
    new Date(date.getTime() + days * DAY + 12 * 3_600_000),
  );
}

function label(query: TaskQuery): string {
  if (query.state === "done") {
    if (query.when === "today") return "Закрыто сегодня";
    if (query.when === "any") return "Закрыто за месяц";
    return "Закрыто за неделю";
  }
  switch (query.when) {
    case "overdue":
      return "Просрочено";
    case "today":
      return "На сегодня";
    case "tomorrow":
      return "На завтра";
    case "week":
      return "На ближайшую неделю";
    default:
      return "Открытые задачи";
  }
}

function filters(query: TaskQuery): string {
  const parts: string[] = [];
  if (query.people.length > 0) parts.push(query.people.join(", "));
  if (query.projectTitle) parts.push(query.projectTitle);
  if (query.text) parts.push(`«${query.text}»`);
  return parts.length > 0 ? ` · ${escapeHtml(parts.join(" · "))}` : "";
}

export async function answerQuestion(
  viewer: Viewer,
  query: TaskQuery,
): Promise<{ text: string; keyboard: Keyboard }> {
  const where: Prisma.TaskWhereInput = {};
  if (query.people.length === 1) where.developers = { has: query.people[0]! };
  if (query.people.length > 1) where.developers = { hasSome: query.people };
  if (query.projectId) where.projectId = query.projectId;
  if (query.text) where.title = { contains: query.text, mode: "insensitive" };

  const today = startOfToday(env.TIMEZONE);
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  let rows: TaskRow[];

  if (query.state === "done") {
    where.status = "done";
    const since =
      query.when === "today" ? today : shiftDays(today, query.when === "any" ? -30 : -7);
    where.completedAt = { gte: since };
    rows = (await findTaskRows(viewer, where, { open: false })).sort(
      (a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    );
  } else {
    if (query.when === "overdue") where.dueAt = { lt: today };
    if (query.when === "today") where.dueAt = { gte: today, lt: tomorrow };
    if (query.when === "tomorrow") {
      where.dueAt = { gte: tomorrow, lt: shiftDays(tomorrow, 1) };
    }
    if (query.when === "week") where.dueAt = { gte: today, lt: shiftDays(today, 7) };
    rows = await findTaskRows(viewer, where);
  }

  const head = `${label(query)}${filters(query)}`;
  if (rows.length === 0) {
    // Сотрудник видит только свою работу. Пустой ответ о коллеге без этой оговорки читался
    // бы как «у Тимура всё в порядке», а это может быть неправдой.
    const scope =
      viewer.role === "admin" ? "" : " Вам видны только задачи, в которых вы участвуете.";
    return renderTaskList(`🔎 ${head}: ничего не нашёл.${scope}`, [], "q");
  }

  // Когда спрашивают не об одном человеке, в строке важно, на ком задача.
  const people = query.people.length !== 1;
  const groups =
    query.state === "open" && query.when === "any"
      ? splitByDeadline(rows).map((group) => ({
          ...group,
          options: { ...group.options, people },
        }))
      : [
          {
            title: null,
            tasks: query.state === "done" ? rows : rows.sort(byUrgency),
            options: { people, due: query.state === "open" },
          },
        ];
  return renderTaskList(`🔎 <b>${head}: ${rows.length}</b>`, groups, "q");
}

/**
 * Какой вопрос стоит за сообщением со списком. «Назад» из открытой задачи задаёт его
 * снова и показывает свежий ответ. Вопрос в данные кнопки не помещается (64 байта), а
 * ради кнопки «Назад» таблица в базе была бы лишней, поэтому память здесь. После
 * перезапуска она пуста, и «Назад» откроет «Мои задачи» — это лучше, чем ошибка.
 */
const asked = new Map<string, TaskQuery>();
const ASKED_LIMIT = 500;

export function rememberQuestion(
  chatId: string,
  messageId: number,
  query: TaskQuery,
): void {
  asked.delete(`${chatId}:${messageId}`);
  asked.set(`${chatId}:${messageId}`, query);
  // Самый старый уходит первым: Map хранит порядок добавления.
  if (asked.size > ASKED_LIMIT) asked.delete(asked.keys().next().value!);
}

export function recallQuestion(chatId: string, messageId: number): TaskQuery | null {
  return asked.get(`${chatId}:${messageId}`) ?? null;
}
