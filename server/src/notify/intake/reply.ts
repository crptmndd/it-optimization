import type { TaskPriority } from "@prisma/client";
import { z } from "zod";
import { auditAs } from "../../audit.js";
import { createNote, NOTE_MAX_LENGTH } from "../../crm/notes.js";
import { TASK_RELATIONS } from "../../crm/tasks/dto.js";
import {
  createTask,
  reachableTask,
  updateTask,
  type UpdateTaskInput,
} from "../../crm/tasks/service.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { afterTaskUpdate, isPrivateChat, taskKeyboard } from "../notifications.js";
import type { TeamUser } from "../team-user.js";
import { escapeHtml, postMessage } from "../telegram.js";
import { formatDate } from "../zone.js";
import { scheduleNotice, type Log } from "./cards.js";
import { attachFiles, type IncomingFile } from "./files.js";
import {
  askModel,
  clip,
  dateBlock,
  dueFrom,
  priorityFrom,
  resolvePeople,
  teamBlock,
  type IntakeContext,
} from "./parse.js";

/**
 * Ответ на сообщение бота о задаче — уведомление, карточку или задачу из `/tasks`.
 * «Сделал, жду доступы» становится заметкой в задаче, «перенеси на пятницу» — новым
 * сроком, «добавь Вадима» — исполнителем, «ещё нужно экспорт» — подзадачей, «готово» —
 * закрытием. Простая реакция («ок», «спасибо») ничего не меняет, и бот молчит: в общем
 * чате на каждое «ок» отвечать нельзя.
 *
 * Модель только раскладывает ответ по полям; меняет задачу `updateTask`, тот же, что у
 * формы CRM, поэтому ответить можно лишь на задачу, которая тебе видна, и правила колонок,
 * дат закрытия и уведомлений те же.
 */

const TASK = {
  ...TASK_RELATIONS,
  project: { select: { id: true, title: true } },
} as const;

const STATUS_LABEL: Record<string, string> = {
  backlog: "К работе",
  todo: "К работе",
  in_progress: "В работе",
  done: "Готово",
  cancelled: "Отменена",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Низкая",
  normal: "Обычная",
  important: "Высокая",
  high: "Срочно",
};

const RULES = `Верни только JSON без пояснений и без markdown, вида:
{"comment":false,"status":null,"due":null,"priority":null,"add":[],"remove":[],"title":null,"subtasks":[]}

Правила:
- comment: true, если в ответе есть то, что стоит сохранить в задаче для команды: что сделано, что мешает, вопрос, ссылка, уточнение, данные. Простая реакция («ок», «спасибо», «понял», «+», эмодзи) — false. Чистая команда без новых сведений («перенеси на пятницу», «добавь Вадима», «готово») — false. Ответ, который только добавляет подзадачи, — false.
- status: "done" — сказано, что задача сделана целиком; "in_progress" — взял в работу, начал; "todo" — вернуть в работу, открыть заново; "cancelled" — отменить, не нужна. Иначе null. «Сделал часть» — не done.
- due: новый срок ГГГГ-ММ-ДД, если просят перенести или назначить срок, по календарю; день недели — ближайший будущий. "none" — если просят убрать срок. Иначе null.
- priority: "low" | "normal" | "important" | "high", только если просят изменить важность («это срочно» → "high"). Иначе null.
- add, remove: кого добавить в исполнители этой задачи и кого снять, именами из списка команды. «Беру», «я возьму» — автор ответа в add. Исполнителей новых подзадач сюда не пиши: они указываются в самой подзадаче.
- title: новое название, только если прямо просят переименовать. Иначе null.
- subtasks: новые пункты работы, если ответ их добавляет («ещё нужно…», «добавь подзадачу…»), каждый с исполнителями, если названы. Иначе пустой список.`;

const rawReply = z.object({
  comment: z.boolean().nullish(),
  status: z.string().nullish(),
  due: z.string().nullish(),
  priority: z.string().nullish(),
  add: z.array(z.string()).nullish(),
  remove: z.array(z.string()).nullish(),
  title: z.string().nullish(),
  subtasks: z
    .array(z.object({ title: z.string(), assignees: z.array(z.string()).nullish() }))
    .nullish(),
});

type ReplyTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

function loadTask(id: string, author: TeamUser) {
  return prisma.task.findFirst({
    where: reachableTask(id, author.viewer),
    include: TASK,
  });
}

function buildPrompt(task: ReplyTask, context: IntakeContext, text: string): string {
  const due = task.dueAt ? formatDate(task.dueAt, env.TIMEZONE) : "нет";
  return [
    "Ты разбираешь ответ на сообщение о задаче в CRM IT-компании: что из него сохранить и что поменять в задаче.",
    "",
    ...dateBlock(context.today),
    "",
    ...teamBlock(context),
    "",
    `Задача: «${task.title}»`,
    ...(task.parent ? [`Это подзадача задачи «${task.parent.title}».`] : []),
    `Статус: ${STATUS_LABEL[task.status] ?? task.status}`,
    `Исполнители: ${task.developers.join(", ") || "не назначены"}`,
    `Срок: ${due}`,
    `Важность: ${PRIORITY_LABEL[task.priority]}`,
    ...(task.project ? [`Проект: ${task.project.title}`] : []),
    "",
    "Ответ:",
    '"""',
    text.replace(/"""/g, '"'),
    '"""',
    "",
    RULES,
  ].join("\n");
}

const STATUSES = ["done", "in_progress", "todo", "cancelled"] as const;

function statusLine(status: string): string {
  switch (status) {
    case "done":
      return "✅ Задача закрыта";
    case "in_progress":
      return "▶️ Задача в работе";
    case "cancelled":
      return "✖️ Задача отменена";
    default:
      return "↩️ Задача снова в работе";
  }
}

export async function handleTaskReply(
  input: {
    author: TeamUser;
    taskId: string;
    /** Подписанный текст для модели. */
    source: string;
    /** Слова человека как есть: они и станут заметкой. */
    plain: string;
    /** Скриншоты и документы из ответа: они ложатся в задачу. */
    files: IncomingFile[];
    context: IntakeContext;
    chatId: string;
    replyTo: number;
  },
  log: Log,
): Promise<void> {
  const { author, context, chatId, replyTo } = input;
  const say = (text: string, keyboard?: ReturnType<typeof taskKeyboard>) =>
    postMessage(chatId, text, { replyTo, keyboard });

  const task = await loadTask(input.taskId, author);
  if (!task) {
    // В общем чате молчим: на каждое «ок» под чужой задачей отвечать «недоступна» — шум.
    if (isPrivateChat(chatId)) await say("Эта задача вам недоступна.");
    return;
  }

  // Только файлы, без слов — разбирать нечего, модель не нужна.
  const parsed = input.source
    ? await askModel(buildPrompt(task, context, input.source), rawReply, 1000)
    : rawReply.parse({});
  const subtask = Boolean(task.parentId);
  const lines: string[] = [];
  const problems: string[] = [];

  // Своего окна у подзадачи нет: её файлы ложатся в задачу, где их увидят.
  const files = await attachFiles(
    task.parentId ?? task.id,
    input.files,
    author.viewer.id,
    log,
  );
  if (files.saved > 0) lines.push(`📎 Прикреплено файлов: ${files.saved}`);
  problems.push(...files.problems);

  // Заметка — слова человека, а не пересказ модели: в карточке должно остаться сказанное.
  if (parsed.comment && input.plain.trim()) {
    const body = subtask
      ? `К подзадаче «${task.title}»: ${input.plain.trim()}`
      : input.plain.trim();
    await createNote(
      "task",
      task.parentId ?? task.id,
      author.viewer.id,
      body.slice(0, NOTE_MAX_LENGTH),
    );
    lines.push(subtask ? "💬 Комментарий сохранён в задаче" : "💬 Комментарий сохранён");
  }

  const update: UpdateTaskInput = {};
  const status = STATUSES.find((value) => value === parsed.status);
  // У подзадачи в CRM только «сделано» и «не сделано».
  if (status && (!subtask || status === "done" || status === "todo")) {
    const current = task.status === "backlog" ? "todo" : task.status;
    if (status !== current) update.status = status;
  }
  if (!subtask) {
    if (parsed.due === "none" && task.dueAt) update.dueAt = null;
    const due = dueFrom(parsed.due, context.today);
    if (due && due.getTime() !== task.dueAt?.getTime()) update.dueAt = due;
    if (parsed.priority) {
      const priority = priorityFrom(parsed.priority);
      if (priority !== task.priority) update.priority = priority;
    }
  }
  // «Ещё нужно экспорт, это Тимуру» — Тимур исполнитель подзадачи, а не всей задачи.
  // Модель упорно пишет его в оба места, а лишний исполнитель задачи получил бы тэг в
  // чате о чужой работе, поэтому граница проведена в коде.
  const subtaskPeople = new Set(
    (parsed.subtasks ?? []).flatMap(
      (item) => resolvePeople(item.assignees, context).developers,
    ),
  );
  const added = resolvePeople(parsed.add, context).developers.filter(
    (name) => !subtaskPeople.has(name),
  );
  const removed = resolvePeople(parsed.remove, context).developers;
  if (added.length > 0 || removed.length > 0) {
    const developers = [
      ...new Set([
        ...task.developers.filter((name) => !removed.includes(name)),
        ...added,
      ]),
    ];
    if (developers.join("\n") !== task.developers.join("\n"))
      update.developers = developers;
  }
  const title = clip(parsed.title, 300);
  if (title && title !== task.title) update.title = title;

  let current = task;
  if (Object.keys(update).length > 0) {
    const result = await updateTask(author.viewer, task.id, update);
    if (!result.ok) {
      problems.push(result.error);
    } else {
      await auditAs(
        author.viewer.id,
        {
          entity: "tasks",
          entityId: task.id,
          action: "update",
          diff: { via: "telegram", fields: Object.keys(update) },
        },
        log,
      );
      afterTaskUpdate(
        {
          existing: result.existing,
          task: result.task,
          actor: { id: author.viewer.id, name: author.name },
        },
        log,
      );
      current = (await loadTask(task.id, author)) ?? current;
      if (update.status) lines.push(statusLine(update.status));
      if (update.dueAt !== undefined) {
        lines.push(
          update.dueAt
            ? `📅 Срок: ${formatDate(update.dueAt, env.TIMEZONE)}`
            : "📅 Срок снят",
        );
      }
      if (update.priority) lines.push(`Важность: ${PRIORITY_LABEL[update.priority]}`);
      if (update.developers) {
        lines.push(
          `👤 Исполнители: ${escapeHtml(update.developers.join(", ") || "не назначены")}`,
        );
      }
      if (update.title) lines.push(`✏️ Название: ${escapeHtml(update.title)}`);
    }
  }

  // Новая работа встаёт подзадачей верхней задачи: вложенность одна.
  const parentId = task.parentId ?? task.id;
  for (const item of (parsed.subtasks ?? []).slice(0, 15)) {
    const itemTitle = clip(item.title, 300);
    if (!itemTitle) continue;
    const created = await createTask(author.viewer, {
      title: itemTitle,
      parentId,
      developers: resolvePeople(item.assignees, context).developers,
    });
    if (!created.ok) {
      problems.push(`«${itemTitle}»: ${created.error}`);
      continue;
    }
    await auditAs(
      author.viewer.id,
      {
        entity: "tasks",
        entityId: created.task.id,
        action: "create",
        diff: { via: "telegram" },
      },
      log,
    );
    scheduleNotice(
      { taskId: created.task.id, author: author.viewer.memberName, skip: [] },
      log,
    );
    lines.push(`🧩 Подзадача: ${escapeHtml(itemTitle)}`);
  }

  for (const problem of problems) lines.push(`⚠️ Не получилось: ${escapeHtml(problem)}`);
  // Реакция ничего не изменила — и ответа нет.
  if (lines.length === 0) return;
  await say(
    [`<b>${escapeHtml(current.title)}</b>`, ...lines].join("\n"),
    taskKeyboard(current),
  );
}
