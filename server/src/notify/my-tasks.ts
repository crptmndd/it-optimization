import type { TaskPriority } from "@prisma/client";
import { liveTask, taskScope, type Viewer } from "../crm/access.js";
import { OPEN_TASK_STATUSES } from "../crm/tasks/dto.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { escapeHtml, fitMessage, type LinkButton } from "./telegram.js";
import { formatDay, startOfToday, startOfTomorrow } from "./zone.js";

/**
 * `/tasks` — всё открытое, что висит на человеке: задачи и подзадачи, где он исполнитель.
 * Сводка `/today` отвечает на «что горит», а здесь — «что на мне вообще»: туда не
 * попадает задача без срока, а именно её и забывают.
 *
 * Видимость та же, что в CRM (`taskScope`), архив руками и закрытые не показываются.
 * Подзадача под архивной задачей тоже уходит: в CRM её не видно, пока родитель в архиве.
 */

const SELECT = {
  id: true,
  title: true,
  priority: true,
  status: true,
  dueAt: true,
  parent: { select: { id: true, title: true, archivedAt: true } },
  project: { select: { title: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadTasks>>[number];

function loadTasks(viewer: Viewer, person: string) {
  return prisma.task.findMany({
    where: {
      developers: { has: person },
      status: { in: [...OPEN_TASK_STATUSES] },
      archivedAt: null,
      AND: [liveTask, taskScope(viewer)],
    },
    select: SELECT,
    take: 300,
  });
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
  normal: "•",
  low: "•",
};

function byUrgency(a: Row, b: Row): number {
  const due = (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity);
  if (due !== 0 && Number.isFinite(due)) return due;
  if (a.dueAt && !b.dueAt) return -1;
  if (!a.dueAt && b.dueAt) return 1;
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : a.title.localeCompare(b.title, "ru");
}

function byPriority(a: Row, b: Row): number {
  const rank = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : byUrgency(a, b);
}

/**
 * Название ведёт в карточку, если есть боевой адрес CRM: так список заменяет поиск.
 * У подзадачи своей карточки нет, ссылка открывает родителя.
 */
function titleOf(task: Row): string {
  const title = escapeHtml(task.title);
  const origin = env.CRM_ORIGIN;
  if (!origin?.startsWith("https://")) return title;
  return `<a href="${origin}/#/tasks?open=${task.parent?.id ?? task.id}">${title}</a>`;
}

function lineOf(task: Row, withDue: boolean): string {
  const meta: string[] = [];
  if (task.parent) meta.push(`в «${escapeHtml(task.parent.title)}»`);
  if (task.project) meta.push(escapeHtml(task.project.title));
  if (withDue && task.dueAt) meta.push(`до ${formatDay(task.dueAt, env.TIMEZONE)}`);
  if (task.status === "in_progress") meta.push("в работе");
  const tail = meta.length > 0 ? ` — ${meta.join(" · ")}` : "";
  return `${PRIORITY_MARK[task.priority]} ${titleOf(task)}${tail}`;
}

export async function myTasksMessage(
  viewer: Viewer,
): Promise<{ text: string; button?: LinkButton }> {
  const person = viewer.memberName;
  if (!person) {
    return {
      text: "Ваша учётка не связана с человеком из команды, поэтому задач на ней нет. Связь ставит админ: CRM → Настройки → Команда.",
    };
  }

  const tasks = (await loadTasks(viewer, person)).filter(
    (task) => !task.parent?.archivedAt,
  );
  const origin = env.CRM_ORIGIN;
  const button = origin?.startsWith("https://")
    ? { text: "Открыть задачи в CRM", url: `${origin}/#/tasks` }
    : undefined;

  if (tasks.length === 0) {
    return { text: "На вас нет открытых задач.", button };
  }

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

  const lines = [`📋 <b>Ваши задачи: ${tasks.length}</b>`];
  if (overdue.length > 0) {
    lines.push("", "<b>Просрочено</b>", ...overdue.map((task) => lineOf(task, true)));
  }
  if (dueToday.length > 0) {
    lines.push("", "<b>На сегодня</b>", ...dueToday.map((task) => lineOf(task, false)));
  }
  if (rest.length > 0) {
    // Заголовок «Остальное» нужен, только если выше было что-то срочное.
    if (overdue.length + dueToday.length > 0) lines.push("", "<b>Остальное</b>");
    else lines.push("");
    lines.push(...rest.map((task) => lineOf(task, true)));
  }

  return {
    text: fitMessage(lines, (dropped) => `…и ещё ${dropped} — в CRM`),
    button,
  };
}
