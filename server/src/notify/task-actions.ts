import { auditAs } from "../audit.js";
import { TASK_RELATIONS } from "../crm/tasks/dto.js";
import {
  reachableTask,
  updateTask,
  type CreatedTask,
  type UpdateTaskInput,
} from "../crm/tasks/service.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { afterTaskUpdate, taskKeyboard, taskMessage } from "./notifications.js";
import { teamUserOf } from "./team-user.js";
import {
  answerCallback,
  editMessage,
  escapeHtml,
  postMessage,
  type Keyboard,
  type TgCallbackQuery,
} from "./telegram.js";
import { formatDate, startOfTomorrow } from "./zone.js";

/**
 * Кнопки под сообщениями о задачах: «Готово», «В работу», «На завтра», «Вернуть в
 * работу» и открытие задачи из списка `/tasks`. Правка идёт через `updateTask`, тот же,
 * что у формы CRM: нажать может только тот, кому задача видна в CRM, а колонка, дата
 * закрытия и архив меняются по тем же правилам. После нажатия сообщение перерисовывается
 * из базы, и в общем чате все видят, что задачу уже закрыли.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_VIEW = {
  ...TASK_RELATIONS,
  project: { select: { id: true, title: true } },
} as const;

/** Конец завтрашнего дня в поясе команды — так срок ставит форма CRM. */
export function endOfTomorrow(): Date {
  const tomorrow = startOfTomorrow(env.TIMEZONE);
  const after = startOfTomorrow(env.TIMEZONE, new Date(tomorrow.getTime() + 3_600_000));
  return new Date(after.getTime() - 1000);
}

async function noteOf(task: { id: string; description: string | null }) {
  const note = await prisma.note.findFirst({
    where: { entity: "task", entityId: task.id },
    orderBy: { createdAt: "desc" },
    select: { body: true },
  });
  return note?.body ?? task.description;
}

/**
 * Задача тем же видом, что и уведомление о ней, плюс строка о последнем действии.
 * Проект показывается только в карточке из `/tasks`: в уведомлении его нет по шаблону
 * владельца, и перерисовка не должна его туда добавлять.
 */
export async function renderTask(
  task: CreatedTask & { project: { title: string } | null },
  options: { footer?: string; project?: boolean } = {},
): Promise<{ text: string; keyboard: Keyboard }> {
  const lines = [
    taskMessage({
      task,
      note: await noteOf(task),
      people: task.developers.map(escapeHtml),
      timeZone: env.TIMEZONE,
    }),
  ];
  if (options.project && task.project) {
    lines.push(`📁 Проект: ${escapeHtml(task.project.title)}`);
  }
  if (options.footer) lines.push("", options.footer);
  return { text: lines.join("\n"), keyboard: taskKeyboard(task) };
}

const ACTIONS: Record<string, { input: () => UpdateTaskInput; toast: string }> = {
  done: { input: () => ({ status: "done" }), toast: "Задача закрыта" },
  work: { input: () => ({ status: "in_progress" }), toast: "Задача в работе" },
  back: { input: () => ({ status: "todo" }), toast: "Задача снова в работе" },
  tmrw: { input: () => ({ dueAt: endOfTomorrow() }), toast: "Срок — завтра" },
};

function footerOf(code: string, task: { dueAt: Date | null }, who: string): string {
  const name = escapeHtml(who);
  switch (code) {
    case "done":
      return `✅ Выполнено · ${name}`;
    case "work":
      return `▶️ В работе · ${name}`;
    case "back":
      return `↩️ Возвращена в работу · ${name}`;
    default:
      return `📅 Срок перенесён на ${task.dueAt ? formatDate(task.dueAt, env.TIMEZONE) : "завтра"} · ${name}`;
  }
}

/** `s:<действие>:<id>` — действие с задачей, `o:<id>` — открыть её из списка. */
export function isTaskAction(data: string | undefined): boolean {
  return Boolean(data && /^[so]:/.test(data));
}

export async function handleTaskAction(query: TgCallbackQuery, log: Log): Promise<void> {
  const parts = (query.data ?? "").split(":");
  const taskId = parts.at(-1) ?? "";
  const message = query.message;
  if (!message || !UUID.test(taskId)) {
    await answerCallback(query.id);
    return;
  }

  const presser = await teamUserOf(query.from.id);
  if (!presser) {
    await answerCallback(query.id, "Кнопки работают у тех, кто подключил бота в CRM.");
    return;
  }

  if (parts[0] === "o") {
    const task = await prisma.task.findFirst({
      where: reachableTask(taskId, presser.viewer),
      include: TASK_VIEW,
    });
    await answerCallback(query.id, task ? undefined : "Эта задача вам недоступна.");
    if (!task) return;
    const view = await renderTask(task, { project: true });
    await postMessage(String(message.chat.id), view.text, { keyboard: view.keyboard });
    return;
  }

  const code = parts[1] ?? "";
  const action = ACTIONS[code];
  if (!action) {
    await answerCallback(query.id);
    return;
  }

  const input = action.input();
  const result = await updateTask(presser.viewer, taskId, input);
  if (!result.ok) {
    // Чужая задача отвечает тем же 404, что и пустая: существование не подтверждаем.
    await answerCallback(
      query.id,
      result.code === 404 ? "Эта задача вам недоступна." : result.error,
    );
    return;
  }

  const { task, existing } = result;
  await auditAs(
    presser.viewer.id,
    {
      entity: "tasks",
      entityId: task.id,
      action: "update",
      diff: {
        via: "telegram",
        ...(input.status && { status: input.status }),
        ...(input.dueAt && { dueAt: input.dueAt.toISOString() }),
      },
    },
    log,
  );
  afterTaskUpdate(
    { existing, task, actor: { id: presser.viewer.id, name: presser.name } },
    log,
  );

  await answerCallback(query.id, action.toast);
  const fresh = await prisma.task.findUnique({
    where: { id: task.id },
    include: TASK_VIEW,
  });
  if (!fresh) return;
  // Карточка из `/tasks` показывает проект, уведомление — нет. Различаются они только
  // текстом, поэтому перерисовка смотрит, была ли строка проекта в самом сообщении.
  const view = await renderTask(fresh, {
    footer: footerOf(code, fresh, presser.name),
    project: Boolean(message.text?.includes("📁 Проект:")),
  });
  await editMessage(
    String(message.chat.id),
    message.message_id,
    view.text,
    view.keyboard,
  );
}
