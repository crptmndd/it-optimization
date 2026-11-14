import type { Prisma, TaskPriority } from "@prisma/client";
import { liveTask, taskScope, type Viewer } from "../crm/access.js";
import {
  archiveCutoff,
  archivedTaskWhere,
  OPEN_TASK_STATUSES,
} from "../crm/tasks/dto.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { escapeHtml, type InlineButton, type Keyboard } from "./telegram.js";
import { formatDay, startOfToday, startOfTomorrow } from "./zone.js";

/**
 * Списки задач в телеграме: `/tasks` (всё открытое на человеке), напоминания о сроках и
 * ответы на вопросы. Вид один: задачи пронумерованы, под списком кнопки с номерами —
 * нажатие присылает задачу с кнопками «Готово», «В работу», «На завтра». Название ведёт в
 * карточку CRM, если есть боевой адрес.
 *
 * Видимость всегда та же, что в CRM (`taskScope`); закрытые, удалённые, убранные в архив
 * руками и подзадачи под архивной задачей не показываются.
 */

const SELECT = {
  id: true,
  title: true,
  priority: true,
  status: true,
  dueAt: true,
  completedAt: true,
  developers: true,
  parent: { select: { id: true, title: true, archivedAt: true } },
  project: { select: { title: true } },
} as const;

export type TaskRow = Prisma.TaskGetPayload<{ select: typeof SELECT }>;

/** Задачи по условию, видимые человеку. `open: false` — и закрытые тоже. */
export async function findTaskRows(
  viewer: Viewer,
  where: Prisma.TaskWhereInput,
  options: { open?: boolean } = {},
): Promise<TaskRow[]> {
  const rows = await prisma.task.findMany({
    where: {
      ...where,
      ...(options.open !== false && { status: { in: [...OPEN_TASK_STATUSES] } }),
      archivedAt: null,
      AND: [liveTask, taskScope(viewer)],
    },
    select: SELECT,
    take: 300,
  });
  return rows.filter((row) => !row.parent?.archivedAt);
}

/** От срочной к низкой: `TASK_PRIORITIES` идёт наоборот. */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  high: 0,
  important: 1,
  normal: 2,
  low: 3,
};

/** Отметка как в CRM: только две верхние важности, обычной и низкой нечего выделять. */
const PRIORITY_MARK: Record<TaskPriority, string> = {
  high: "🔴",
  important: "🟠",
  normal: "",
  low: "",
};

export function byUrgency(a: TaskRow, b: TaskRow): number {
  const due = (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);
  if (due !== 0 && Number.isFinite(due)) return due;
  if (a.dueAt && !b.dueAt) return -1;
  if (!a.dueAt && b.dueAt) return 1;
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : a.title.localeCompare(b.title, "ru");
}

export function byPriority(a: TaskRow, b: TaskRow): number {
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : byUrgency(a, b);
}

/** У подзадачи своей карточки нет, ссылка открывает родителя. */
function titleOf(task: TaskRow): string {
  const title = escapeHtml(task.title);
  const origin = env.CRM_ORIGIN;
  if (!origin?.startsWith("https://")) return title;
  return `<a href="${origin}/#/tasks?open=${task.parent?.id ?? task.id}">${title}</a>`;
}

export interface LineOptions {
  /** Показывать срок: в разделе «На сегодня» он и так понятен. */
  due?: boolean;
  /** Показывать исполнителей: в чужом списке важно, на ком задача. */
  people?: boolean;
  /** Показывать дату закрытия: в архиве она важнее срока. */
  closed?: boolean;
}

function lineOf(task: TaskRow, number: number, options: LineOptions): string {
  const meta: string[] = [];
  if (options.people && task.developers.length > 0) {
    meta.push(escapeHtml(task.developers.join(", ")));
  }
  if (task.parent) meta.push(`в «${escapeHtml(task.parent.title)}»`);
  if (task.project) meta.push(escapeHtml(task.project.title));
  if (options.due !== false && task.dueAt) {
    meta.push(`до ${formatDay(task.dueAt, env.TIMEZONE)}`);
  }
  if (task.status === "in_progress") meta.push("в работе");
  if (task.status === "done") meta.push("✅ готово");
  if (task.status === "cancelled") meta.push("✖️ отменена");
  if (options.closed && task.completedAt) {
    meta.push(`закрыта ${formatDay(task.completedAt, env.TIMEZONE)}`);
  }
  const tail = meta.length > 0 ? ` — ${meta.join(" · ")}` : "";
  const mark = PRIORITY_MARK[task.priority];
  return `${number}. ${mark ? `${mark} ` : ""}${titleOf(task)}${tail}`;
}

export interface TaskGroup {
  /** Подзаголовок раздела; `null` — без него. */
  title: string | null;
  tasks: TaskRow[];
  options?: LineOptions;
}

/**
 * Пронумерованных строк не больше этого: под каждой — кнопка, а сообщение длиннее
 * 4096 символов телеграм не примет. Остальное честно сказано в хвосте.
 */
const LIST_LIMIT = 30;
const BUTTONS_PER_ROW = 6;

/**
 * Откуда список: «мои задачи» (`/tasks`), архив (`/archive`), вечерние сроки или ответ
 * на вопрос. Едет в
 * кнопке-номере, чтобы «Назад» из открытой задачи собрал тот же список заново, а не
 * какой-то другой.
 */
export type ListKind = "m" | "r" | "q" | "a";

export function renderTaskList(
  header: string,
  groups: TaskGroup[],
  kind: ListKind = "m",
): { text: string; keyboard: Keyboard } {
  const lines = [header];
  const shown: TaskRow[] = [];
  let hidden = 0;

  for (const group of groups) {
    if (group.tasks.length === 0) continue;
    const room = LIST_LIMIT - shown.length;
    if (room <= 0) {
      hidden += group.tasks.length;
      continue;
    }
    lines.push("");
    if (group.title) lines.push(`<b>${escapeHtml(group.title)}</b>`);
    for (const task of group.tasks.slice(0, room)) {
      shown.push(task);
      lines.push(lineOf(task, shown.length, group.options ?? {}));
    }
    hidden += Math.max(0, group.tasks.length - room);
  }
  if (hidden > 0) lines.push("", `…и ещё ${hidden} — в CRM`);

  const numbers: InlineButton[] = shown.map((task, index) => ({
    text: String(index + 1),
    callback_data: `o:${kind}:${task.id}`,
  }));
  const keyboard: Keyboard = [];
  for (let index = 0; index < numbers.length; index += BUTTONS_PER_ROW) {
    keyboard.push(numbers.slice(index, index + BUTTONS_PER_ROW));
  }
  const origin = env.CRM_ORIGIN;
  if (origin?.startsWith("https://")) {
    keyboard.push([{ text: "Открыть задачи в CRM", url: `${origin}/#/tasks` }]);
  }
  if (shown.length > 0) lines.push("", "Номер под списком открывает задачу с кнопками.");
  return { text: lines.join("\n"), keyboard };
}

/** Просрочено, на сегодня и остальное: так человек видит, с чего начать. */
export function splitByDeadline(tasks: TaskRow[]): TaskGroup[] {
  const today = startOfToday(env.TIMEZONE);
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  const overdue = tasks
    .filter((task) => task.dueAt && task.dueAt < today)
    .sort(byUrgency);
  const dueToday = tasks
    .filter((task) => task.dueAt && task.dueAt >= today && task.dueAt < tomorrow)
    .sort(byPriority);
  const rest = tasks
    .filter((task) => !task.dueAt || task.dueAt >= tomorrow)
    .sort(byPriority);
  const urgent = overdue.length + dueToday.length > 0;
  return [
    { title: "Просрочено", tasks: overdue },
    { title: "На сегодня", tasks: dueToday, options: { due: false } },
    // Заголовок «Остальное» нужен, только если выше было что-то срочное.
    { title: urgent ? "Остальное" : null, tasks: rest },
  ];
}

export async function myTasksMessage(
  viewer: Viewer,
): Promise<{ text: string; keyboard?: Keyboard }> {
  const person = viewer.memberName;
  if (!person) {
    return {
      text: NOT_LINKED,
    };
  }

  const tasks = await findTaskRows(viewer, { developers: { has: person } });
  if (tasks.length === 0) {
    return renderTaskList("На вас нет открытых задач.", []);
  }
  return renderTaskList(`📋 <b>Ваши задачи: ${tasks.length}</b>`, splitByDeadline(tasks));
}

const NOT_LINKED =
  "Ваша учётка не связана с человеком из команды, поэтому задач на ней нет. Связь ставит админ: CRM → Настройки → Команда.";

/**
 * `/archive` — задачи человека в архиве: закрытые больше трёх дней назад и убранные
 * руками («Проверено»). То же правило, что у вкладки «Архив» в CRM, и та же видимость.
 * Архив растёт без конца, поэтому показаны последние закрытые; номер открывает задачу, и
 * «↩️ Вернуть в работу» возвращает её на доску.
 */
export async function archiveMessage(
  viewer: Viewer,
): Promise<{ text: string; keyboard?: Keyboard }> {
  const person = viewer.memberName;
  if (!person) return { text: NOT_LINKED };

  const where: Prisma.TaskWhereInput = {
    parentId: null,
    developers: { has: person },
    AND: [liveTask, taskScope(viewer), archivedTaskWhere(archiveCutoff())],
  };
  const [total, tasks] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      select: SELECT,
      orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: LIST_LIMIT,
    }),
  ]);
  if (total === 0) return renderTaskList("🗄 В архиве ваших задач пока нет.", [], "a");
  const header =
    total > tasks.length
      ? `🗄 <b>Архив: ${total}</b> · последние ${tasks.length}, остальные — в CRM`
      : `🗄 <b>Архив: ${total}</b>`;
  return renderTaskList(
    header,
    [{ title: null, tasks, options: { due: false, closed: true } }],
    "a",
  );
}
