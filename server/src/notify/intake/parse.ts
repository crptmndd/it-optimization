import type { TaskPriority } from "@prisma/client";
import { z } from "zod";
import { complete } from "../../ai/replicate.js";
import { liveTask, projectScope, taskScope, type Viewer } from "../../crm/access.js";
import { NOTE_MAX_LENGTH } from "../../crm/notes.js";
import { MAX_DEVELOPERS } from "../../crm/people.js";
import { OPEN_TASK_STATUSES, TASK_PRIORITIES } from "../../crm/tasks/dto.js";
import { prisma } from "../../db.js";
import { env } from "../../env.js";
import { startOfTomorrow, zonedNow } from "../zone.js";

/**
 * Сообщение → задачи. Модель видит команду, проекты и открытые задачи того, кто пишет,
 * и возвращает JSON. Всё, что она вернула, проверяется здесь: имя исполнителя должно быть
 * в команде, проект и родитель — из выданного ей списка, срок — настоящей датой. Модель
 * подсказывает, решает код.
 *
 * Проекты и задачи передаются короткими кодами (P3, T12), а не идентификаторами: короткий
 * код модель не исказит, а выдуманный не совпадёт ни с чем и просто отбросится.
 */

export interface Person {
  name: string;
  handle: string | null;
}

interface ProjectRef {
  id: string;
  title: string;
}

interface TaskRef {
  id: string;
  title: string;
  project: string | null;
}

export interface IntakeContext {
  /** Имя автора в команде: «мне» и «себе» — это он. У учётки без человека — пусто. */
  author: string | null;
  people: Person[];
  projects: Map<string, ProjectRef>;
  tasks: Map<string, TaskRef>;
  /** Карточка, на которую автор ответил: дополнение к ней почти всегда подзадача. */
  focus: string | null;
  today: string;
}

/** Потолки контекста: больше модели не нужно, а каждая строка — деньги и время. */
const PROJECT_LIMIT = 40;
const TASK_LIMIT = 60;

/**
 * Команда целиком, а не только люди с учёткой: исполнителем бывает и тот, у кого входа
 * нет. Отключённых нет: на них задачи уже не ставят.
 */
export async function loadPeople(): Promise<Person[]> {
  const members = await prisma.teamMember.findMany({
    select: {
      name: true,
      telegramUsername: true,
      user: { select: { disabledAt: true } },
    },
    orderBy: { name: "asc" },
  });
  return members
    .filter((member) => !member.user?.disabledAt)
    .map((member) => ({ name: member.name, handle: member.telegramUsername }));
}

/**
 * Только то, что человек видит в CRM: сотрудник не поставит задачу в чужой проект и не
 * узнает через бота названия чужих задач.
 */
export async function loadContext(
  viewer: Viewer,
  author: string | null,
  focusTaskId: string | null,
): Promise<IntakeContext> {
  const openTask = {
    parentId: null,
    archivedAt: null,
    status: { in: [...OPEN_TASK_STATUSES] },
    AND: [liveTask, taskScope(viewer)],
  };
  const [people, projects, tasks, focus] = await Promise.all([
    loadPeople(),
    prisma.project.findMany({
      where: {
        deletedAt: null,
        archivedAt: null,
        status: { in: ["planned", "active", "on_hold"] },
        AND: [projectScope(viewer)],
      },
      orderBy: { updatedAt: "desc" },
      take: PROJECT_LIMIT,
      select: { id: true, title: true },
    }),
    prisma.task.findMany({
      where: openTask,
      orderBy: { updatedAt: "desc" },
      take: TASK_LIMIT,
      select: { id: true, title: true, projectId: true },
    }),
    focusTaskId
      ? prisma.task.findFirst({
          where: { id: focusTaskId, parentId: null, AND: [liveTask, taskScope(viewer)] },
          select: { id: true, title: true, projectId: true },
        })
      : null,
  ]);

  const projectCodes = new Map<string, string>();
  const projectMap = new Map<string, ProjectRef>();
  projects.forEach((project, index) => {
    const code = `P${index + 1}`;
    projectCodes.set(project.id, code);
    projectMap.set(code, project);
  });

  // Карточка, на которую ответили, идёт первой, даже если она старше остальных.
  const ordered = focus
    ? [focus, ...tasks.filter((task) => task.id !== focus.id)]
    : tasks;
  const taskMap = new Map<string, TaskRef>();
  ordered.forEach((task, index) => {
    taskMap.set(`T${index + 1}`, {
      id: task.id,
      title: task.title,
      project: task.projectId ? (projectCodes.get(task.projectId) ?? null) : null,
    });
  });

  return {
    author,
    people,
    projects: projectMap,
    tasks: taskMap,
    focus: focus ? "T1" : null,
    today: zonedNow(env.TIMEZONE).date,
  };
}

const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WEEKDAY_NAMES = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

/** Дата через `offset` дней. Календарная арифметика в UTC: часовой пояс здесь уже учтён. */
function shiftDay(day: string, offset: number): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + offset));
}

/**
 * Две недели вперёд с днями недели. Без этого модель считает «к среде» сама и ошибается:
 * в среду она ставила срок на четверг вместо следующей среды.
 */
function calendar(today: string): string {
  const days: string[] = [];
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = shiftDay(today, offset);
    days.push(`${WEEKDAYS[date.getUTCDay()]} ${date.toISOString().slice(0, 10)}`);
  }
  return days.join(", ");
}

/** Сегодняшняя дата и календарь на две недели — общая шапка всех запросов к модели. */
export function dateBlock(today: string): string[] {
  const weekday = WEEKDAY_NAMES[shiftDay(today, 0).getUTCDay()];
  return [`Сегодня ${weekday}, ${today}.`, `Календарь: ${calendar(today)}.`];
}

/** Команда списком: имя, ник, кто автор. Исполнителей модель берёт только отсюда. */
export function teamBlock(context: {
  people: Person[];
  author: string | null;
}): string[] {
  const people = context.people.map((person) => {
    const handle = person.handle ? ` (ник @${person.handle})` : "";
    const author = person.name === context.author ? " — автор сообщения" : "";
    return `- ${person.name}${handle}${author}`;
  });
  return [
    "Команда (исполнитель — только из этого списка, имя пиши ровно как здесь, без ника):",
    ...(people.length > 0 ? people : ["(пусто)"]),
    ...(context.author ? [] : ["Автор сообщения в списке команды не значится."]),
  ];
}

function contextBlock(context: IntakeContext): string {
  const projects = [...context.projects].map(
    ([code, project]) => `${code}: ${project.title}`,
  );
  const tasks = [...context.tasks].map(([code, task]) => {
    const project = task.project ? ` [${task.project}]` : "";
    return `${code}: ${task.title}${project}`;
  });

  return [
    ...dateBlock(context.today),
    "",
    ...teamBlock(context),
    "",
    "Проекты:",
    ...(projects.length > 0 ? projects : ["(нет)"]),
    "",
    "Открытые задачи (к ним можно добавить подзадачу):",
    ...(tasks.length > 0 ? tasks : ["(нет)"]),
    ...(context.focus
      ? [
          "",
          `Автор отвечает на карточку задачи ${context.focus}: если сообщение дополняет её, это её подзадача (parent ${context.focus}).`,
        ]
      : []),
  ].join("\n");
}

const RULES = `Верни только JSON без пояснений и без markdown, вида:
{"intent":"task","tasks":[{"title":"...","note":null,"assignees":["..."],"project":null,"parent":null,"due":null,"priority":"normal","subtasks":[{"title":"...","assignees":[]}]}],"query":null}

Сначала реши, что это:
- intent "task" — поручение: что-то нужно сделать. Тогда заполни tasks, query null.
- intent "question" — автор спрашивает о задачах или проектах, а не поручает («что у Вадима просрочено?», «какие задачи по кошельку?», «что я закрыл на этой неделе?», «что на завтра?»). Тогда tasks пустой, а query такой:
  {"people":["..."],"project":null,"when":"any","state":"open","text":null}
  - people: о ком спрашивают, именами из списка команды; «я», «мои», «у меня» — автор; ни о ком конкретно — пустой список.
  - project: код проекта, если спрашивают о нём, иначе null.
  - when: "overdue" — просроченные; "today" — на сегодня; "tomorrow" — на завтра; "week" — на ближайшую неделю, а для закрытых — за последнюю неделю; иначе "any".
  - state: "done" — если спрашивают, что сделано или закрыто; иначе "open".
  - text: слово или короткая фраза для поиска по названиям задач, если спрашивают о конкретной теме, которой нет среди проектов; иначе null.
- Сомневаешься — это поручение.

Правила для задач:
- title: коротко, как в трекере задач, до 100 символов. Без имени исполнителя и срока: «Фиксы по кошельку Камилю» → «Фиксы по кошельку».
- assignees: кому поручено. Имена в любом падеже («Камилю», «на Вадима», «для Тимура») и ники приводи к имени из списка команды. «Мне», «себе», «я» — автор сообщения. Никто не назван — пустой список.
- project: код проекта, если задача явно про него (по названию, клиенту, продукту), иначе null. Не угадывай.
- parent: код задачи, только если автор прямо называет сообщение подзадачей, пунктом или частью задачи из списка («в задачу про кошелёк добавь…», «подзадача к…»). Похожее или совпадающее название — не повод: это новая задача, parent null. При parent поля project и subtasks не заполняй.
- due: срок в формате ГГГГ-ММ-ДД, если назван («завтра», «до пятницы», «к 15-му»): бери дату из календаря. День недели — ближайший будущий, не сегодняшний: «к среде», сказанное в среду, — среда через неделю. «Сегодня» — сегодняшняя дата. Нет срока — null.
- priority: "high" — срочно, горит, asap; "important" — важно; "low" — не срочно, когда-нибудь; иначе "normal".
- note: детали, нужные исполнителю и не вошедшие в название: ссылки, шаги, телефоны, суммы, слова клиента. Исполнителя, срок, срочность и кто поручил в note не пиши: для них есть поля. Пункты, ставшие подзадачами, в note не повторяй. Нечего добавить — null. Ничего не выдумывай.
- subtasks: список пунктов одной работы (нумерованный, через дефис или перечислением) — это подзадачи (до 15), а не note. У каждой свой исполнитель, если он назван отдельно. Нет списка — пустой список.
- Несколько задач — только если в сообщении явно разные поручения (разным людям или про разное). Обычно задача одна.
- Автор пересланного сообщения — не исполнитель, если его не назначили.
- Если это не поручение и не вопрос, верни {"intent":"task","tasks":[],"query":null}.`;

export function buildPrompt(context: IntakeContext, message: string): string {
  return [
    "Ты разбираешь сообщения из телеграма в задачи для CRM IT-компании.",
    "",
    contextBlock(context),
    "",
    "Сообщение:",
    '"""',
    message.replace(/"""/g, '"'),
    '"""',
    "",
    RULES,
  ].join("\n");
}

/** Ответ модели как есть: строже проверять здесь нельзя, иначе одна мелочь губит всё. */
const rawQuery = z.object({
  people: z.array(z.string()).nullish(),
  project: z.string().nullish(),
  when: z.string().nullish(),
  state: z.string().nullish(),
  text: z.string().nullish(),
});

const rawPlan = z.object({
  intent: z.string().nullish(),
  query: rawQuery.nullish(),
  tasks: z.array(
    z.object({
      title: z.string(),
      note: z.string().nullish(),
      assignees: z.array(z.string()).nullish(),
      project: z.string().nullish(),
      parent: z.string().nullish(),
      due: z.string().nullish(),
      priority: z.string().nullish(),
      subtasks: z
        .array(z.object({ title: z.string(), assignees: z.array(z.string()).nullish() }))
        .nullish(),
    }),
  ),
});

export interface PlannedSubtask {
  title: string;
  developers: string[];
  unknown: string[];
}

export interface PlannedTask {
  title: string;
  note: string | null;
  developers: string[];
  /** Кого модель назвала, но в команде такого нет: карточка об этом скажет. */
  unknown: string[];
  projectId: string | null;
  parentId: string | null;
  dueAt: Date | null;
  priority: TaskPriority;
  subtasks: PlannedSubtask[];
}

const MAX_TASKS = 5;
const MAX_SUBTASKS = 15;

function fold(value: string): string {
  return value.toLowerCase().replace(/ё/g, "е").trim();
}

const SELF = new Set([
  "я",
  "мне",
  "меня",
  "себе",
  "сам",
  "сама",
  "автор",
  "автор сообщения",
]);

/**
 * Имя из ответа модели → человек из команды. Модель иногда оставляет падеж («Камилю»)
 * или дописывает ник в скобках, поэтому после точного совпадения идёт совпадение по
 * основе имени. Принимается только единственный кандидат: Тимур и Тимофей при «Тиму»
 * не угадываются, а уходят в «не нашёл».
 */
export function resolvePerson(
  raw: string,
  people: Person[],
  author: string | null,
): string | null {
  const handle = raw.match(/@([A-Za-z0-9_]{3,})/)?.[1];
  if (handle) {
    const byHandle = people.find((p) => p.handle && fold(p.handle) === fold(handle));
    if (byHandle) return byHandle.name;
  }

  const clean = fold(raw.replace(/\(.*?\)/g, "").replace(/@[A-Za-z0-9_]+/g, ""));
  if (!clean) return null;
  if (SELF.has(clean)) return author;

  const exact = people.find((person) => fold(person.name) === clean);
  if (exact) return exact.name;

  const word = clean.split(/\s+/)[0]!;
  const matches = people.filter((person) => {
    const first = fold(person.name).split(/\s+/)[0]!;
    const stem = first.slice(0, Math.max(3, first.length - 2));
    return word.startsWith(stem) && Math.abs(word.length - first.length) <= 3;
  });
  return matches.length === 1 ? matches[0]!.name : null;
}

export function resolvePeople(
  names: string[] | null | undefined,
  context: { people: Person[]; author: string | null },
): { developers: string[]; unknown: string[] } {
  const developers: string[] = [];
  const unknown: string[] = [];
  for (const raw of names ?? []) {
    const name = resolvePerson(raw, context.people, context.author);
    if (name) {
      if (!developers.includes(name)) developers.push(name);
    } else if (raw.trim()) {
      unknown.push(raw.trim());
    }
  }
  return { developers: developers.slice(0, MAX_DEVELOPERS), unknown };
}

export function clip(value: string | null | undefined, max: number): string {
  const clean = (value ?? "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Срок — конец дня в поясе команды, как его ставит форма CRM. Полдень по UTC заведомо
 * внутри нужных суток при любом поясе в пределах ±11 часов. Даты в прошлом и дальше двух
 * лет — почти наверняка ошибка модели, такой срок не ставится вовсе.
 */
export function dueFrom(value: string | null | undefined, today: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const noon = new Date(Date.UTC(year!, month! - 1, day!, 12));
  if (Number.isNaN(noon.getTime()) || noon.toISOString().slice(0, 10) !== value)
    return null;
  if (value < today || value > shiftDay(today, 730).toISOString().slice(0, 10))
    return null;
  return new Date(startOfTomorrow(env.TIMEZONE, noon).getTime() - 1000);
}

export function priorityFrom(value: string | null | undefined): TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value ?? "")
    ? (value as TaskPriority)
    : "normal";
}

function code(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

function toPlan(raw: z.infer<typeof rawPlan>, context: IntakeContext): PlannedTask[] {
  return raw.tasks.slice(0, MAX_TASKS).flatMap((item): PlannedTask[] => {
    const title = clip(item.title, 300);
    if (!title) return [];

    const parent = context.tasks.get(code(item.parent));
    const project = parent ? undefined : context.projects.get(code(item.project));
    const people = resolvePeople(item.assignees, context);

    const subtasks = parent
      ? []
      : (item.subtasks ?? []).slice(0, MAX_SUBTASKS).flatMap((sub): PlannedSubtask[] => {
          const subTitle = clip(sub.title, 300);
          return subTitle
            ? [{ title: subTitle, ...resolvePeople(sub.assignees, context) }]
            : [];
        });

    return [
      {
        title,
        note: clip(item.note, NOTE_MAX_LENGTH) || null,
        ...people,
        projectId: project?.id ?? null,
        parentId: parent?.id ?? null,
        dueAt: dueFrom(item.due, context.today),
        priority: priorityFrom(item.priority),
        subtasks,
      },
    ];
  });
}

/**
 * JSON из ответа. Модели с рассуждением пишут его перед ответом, остальные иногда
 * заворачивают JSON в markdown, поэтому берётся промежуток от первой скобки до последней.
 */
function extractJson(text: string): unknown {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("в ответе модели нет JSON");
  return JSON.parse(answer.slice(start, end + 1));
}

/** Ответ модели не разобрался и со второго раза. */
export class PlanError extends Error {
  override name = "PlanError";
}

/**
 * Запрос к модели с ответом в JSON по схеме. Вторая попытка — на случай оборванного или
 * кривого JSON: такое бывает редко и не повторяется подряд.
 */
export async function askModel<T>(
  prompt: string,
  schema: z.ZodType<T>,
  maxTokens = 2000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const answer = await complete(prompt, maxTokens);
    try {
      return schema.parse(extractJson(answer));
    } catch (cause) {
      lastError = cause;
    }
  }
  throw new PlanError(`модель вернула не то: ${String(lastError)}`);
}

/** Вопрос о задачах: о ком, по какому проекту, за какое время. Код превращает его в выборку. */
export interface TaskQuery {
  people: string[];
  projectId: string | null;
  projectTitle: string | null;
  when: "overdue" | "today" | "tomorrow" | "week" | "any";
  state: "open" | "done";
  text: string | null;
}

const WHEN = ["overdue", "today", "tomorrow", "week", "any"] as const;

function toQuery(raw: z.infer<typeof rawQuery>, context: IntakeContext): TaskQuery {
  const project = context.projects.get(code(raw.project));
  return {
    people: resolvePeople(raw.people, context).developers,
    projectId: project?.id ?? null,
    projectTitle: project?.title ?? null,
    when: WHEN.find((value) => value === raw.when) ?? "any",
    state: raw.state === "done" ? "done" : "open",
    text: clip(raw.text, 100) || null,
  };
}

export type Plan =
  { intent: "task"; tasks: PlannedTask[] } | { intent: "question"; query: TaskQuery };

/**
 * Поручение или вопрос. Пустой список задач значит «поручения здесь нет»: это ответ, а
 * не сбой. Сомнение решается в пользу поручения: лишнюю задачу отменяют одной кнопкой.
 */
export async function planTasks(context: IntakeContext, message: string): Promise<Plan> {
  const raw = await askModel(buildPrompt(context, message), rawPlan);
  if (raw.intent === "question" && raw.query) {
    return { intent: "question", query: toQuery(raw.query, context) };
  }
  return { intent: "task", tasks: toPlan(raw, context) };
}

/**
 * Подсказка для расшифровки голоса: имена и проекты. Whisper берёт из неё написание,
 * а длиннее пары сотен слов она ему не нужна.
 */
export function speechHint(context: IntakeContext): string {
  const names = context.people.map((person) => person.name).join(", ");
  const projects = [...context.projects.values()]
    .slice(0, 12)
    .map((project) => project.title)
    .join(", ");
  return clip(`Задачи команды. ${names}. Проекты: ${projects}.`, 600);
}
