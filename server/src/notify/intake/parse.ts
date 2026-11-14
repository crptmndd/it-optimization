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
- title: коротко, как в трекере задач: 3–10 слов, до 100 символов. Без имени исполнителя и срока: «Фиксы по кошельку Камилю» → «Фиксы по кошельку». Сохраняй главное конкретное слово — название сервиса, соцсети, продукта, клиента, города: «Изучить парсинг Threads», а не «Создать парсер социальной сети». Действие — то, что сказано: «изучить», «проработать возможность», «ознакомиться» не превращай в «создать» или «реализовать».
- assignees: кому поручено. Имена в любом падеже («Камилю», «на Вадима», «для Тимура») и ники приводи к имени из списка команды. «Мне», «себе», «я» — автор сообщения. Никто не назван — пустой список.
- project: код проекта, если задача явно про него (по названию, клиенту, продукту), иначе null. Не угадывай.
- parent: код задачи, только если автор прямо называет сообщение подзадачей, пунктом или частью задачи из списка («в задачу про кошелёк добавь…», «подзадача к…»). Похожее или совпадающее название — не повод: это новая задача, parent null. При parent поля project и subtasks не заполняй.
- due: срок в формате ГГГГ-ММ-ДД, если назван («завтра», «до пятницы», «к 15-му»): бери дату из календаря. День недели — ближайший будущий, не сегодняшний: «к среде», сказанное в среду, — среда через неделю. «Сегодня» — сегодняшняя дата. Нет срока — null.
- priority: "high" — срочно, горит, asap; "important" — важно; "low" — не срочно, когда-нибудь; иначе "normal".
- note: детали, нужные исполнителю и не вошедшие в название, — словами автора и со всей конкретикой: названия сервисов и продуктов, ссылки, шаги, телефоны, суммы, условия, примеры, слова клиента. Не обобщай и не пересказывай своими словами: «соцсеть Threads», а не «социальная сеть». Исполнителя, срок, срочность и кто поручил в note не пиши: для них есть поля. Пункты, ставшие подзадачами, в note не повторяй. Пометки [фото], [видео], [файл] — это вложения, они прикрепятся к задаче сами: в note о них не пиши. Нечего добавить — null. Ничего не выдумывай.
- subtasks: список пунктов одной работы (нумерованный, через дефис или перечислением) — это подзадачи (до 15), а не note. У каждой свой исполнитель, если он назван отдельно. Нет списка — пустой список.
- Несколько задач — только если в сообщении явно разные поручения (разным людям или про разное). Обычно задача одна.
- Автор пересланного сообщения — не исполнитель, если его не назначили.
- Строка с пометкой (голосом) — расшифровка голосового, в ней бывают ошибки распознавания. Слово, похожее на имя из команды или на название проекта, считай им. Явную ошибку распознавания в название не переноси.
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

/**
 * Ответ модели как есть: строже проверять здесь нельзя, иначе одна мелочь губит всё.
 * Поэтому каждое поле прощает обычные промахи модели: число или объект на месте строки
 * становятся пустым значением, одно имя строкой вместо списка — списком из одного, кривой
 * пункт списка выпадает, а не роняет весь разбор. Что пустое — то код и так не ставит.
 */
export const looseText = z.preprocess(
  (value) =>
    typeof value === "string" ? value : typeof value === "number" ? String(value) : null,
  z.string().nullable(),
);

export const looseNames = z.preprocess(
  (value) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : null,
  z.array(z.string()).nullable(),
);

/** Список объектов, где кривой элемент выпадает, а остальные остаются. */
export function looseList<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            const parsed = item.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : null,
    z.array(z.any()).nullable(),
  ) as unknown as z.ZodType<z.infer<T>[] | null>;
}

const rawQuery = z.object({
  people: looseNames,
  project: looseText,
  when: looseText,
  state: looseText,
  text: looseText,
});

const rawSubtask = z.object({ title: looseText, assignees: looseNames });

const rawPlan = z.object({
  intent: looseText,
  query: rawQuery.nullish().catch(null),
  tasks: looseList(
    z.object({
      title: looseText,
      note: looseText,
      assignees: looseNames,
      project: looseText,
      parent: looseText,
      due: looseText,
      priority: looseText,
      subtasks: looseList(rawSubtask),
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

/**
 * Пометки «[фото]», «[файл «…»]» нужны модели, чтобы понять сообщение, но в описании
 * задачи им не место: сами файлы лежат во вложениях. Модель их иногда переносит.
 */
function withoutMarks(note: string | null | undefined): string {
  return (note ?? "").replace(/\[(?:фото|видео|файл[^\]]*)\]/gi, "").trim();
}

/**
 * Подзадачей сообщение становится, только если автор сказал это прямо или ответил на
 * карточку задачи. Модель охотно цепляет новую задачу к похожей по названию («кнопка
 * оплаты съехала» → «Баг в оплате»), и правило в запросе её не удерживает: граница в коде.
 */
const EXPLICIT_PARENT = /подзадач|в задач|к задач|пункт|в рамках/i;

function projectOfTask(task: { project: string | null }, context: IntakeContext) {
  return task.project ? context.projects.get(task.project) : undefined;
}

function toPlan(
  raw: z.infer<typeof rawPlan>,
  context: IntakeContext,
  allowParent: boolean,
): PlannedTask[] {
  return (raw.tasks ?? []).slice(0, MAX_TASKS).flatMap((item): PlannedTask[] => {
    const title = clip(item.title, 300);
    if (!title) return [];

    const suggested = context.tasks.get(code(item.parent));
    const parent = allowParent ? suggested : undefined;
    // Отвергнутый родитель всё же подсказывает проект: задача про то же самое.
    const project = parent
      ? undefined
      : (context.projects.get(code(item.project)) ??
        (suggested ? projectOfTask(suggested, context) : undefined));
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
        note: clip(withoutMarks(item.note), NOTE_MAX_LENGTH) || null,
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

/** Что не так с ответом — коротко, для второй попытки и для журнала. */
function describeProblem(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    return cause.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "ответ"}: ${issue.message}`)
      .join("; ");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Запрос к модели с ответом в JSON по схеме. Вторая попытка — на случай оборванного или
 * кривого JSON. Не тем же запросом: при низкой температуре он почти всегда даёт тот же
 * ответ, поэтому во второй раз модель узнаёт, что именно в первом не разобралось.
 */
export async function askModel<T>(
  prompt: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  maxTokens = 2000,
): Promise<T> {
  let problem = "";
  let answer = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const request =
      attempt === 1
        ? prompt
        : `${prompt}

Твой прошлый ответ не удалось разобрать (${problem}). Ответь заново: только JSON указанного вида, без пояснений, рассуждений и markdown.`;
    answer = await complete(request, maxTokens);
    try {
      return schema.parse(extractJson(answer));
    } catch (cause) {
      problem = clip(describeProblem(cause), 200);
    }
  }
  // Начало ответа — в журнал: по нему видно, что модель вернула вместо JSON.
  throw new PlanError(`модель вернула не то: ${problem}; ответ: ${clip(answer, 300)}`);
}

const URGENT = /срочн|горит|asap|немедленн/i;

/**
 * Задача из текста как есть — когда модель не ответила, ответила не то или Replicate
 * недоступен. Лучше задача с неидеальным названием, чем потерянное поручение: название,
 * исполнителя и срок поправят на карточке, а «Отменить» уберёт лишнюю.
 *
 * Без модели код угадывает только то, что видно наверняка: исполнитель — названный по
 * имени (слово с большой буквы в любом падеже, и только если такой человек один), срок —
 * «сегодня» или «завтра», важность — «срочно». Имя в начале («Тимуру заменить…») — это
 * адресат, в название оно не идёт. Весь текст ложится в заметку: там детали и ссылки.
 */
export function fallbackTask(
  own: string,
  everything: string,
  context: IntakeContext,
): PlannedTask | null {
  const base = (own.trim() || everything.trim()).replace(/^\(голосом\)\s*/, "");
  const line = base.split("\n").find((item) => item.trim()) ?? "";
  if (!line.trim()) return null;

  const bare = (word: string) => word.replace(/[^\p{L}\p{N}@_]/gu, "");
  const words = line.trim().split(/\s+/);
  const named = words.map(bare).filter((word) => /^(\p{Lu}|@)/u.test(word));
  const { developers } = resolvePeople(named, context);

  const lead = bare(words[0] ?? "");
  const addressed =
    words.length > 1 && lead && resolvePerson(lead, context.people, context.author);
  const rest = (addressed ? words.slice(1) : words)
    .join(" ")
    .replace(/^[,:—-]\s*/, "")
    // Набранное на ходу «название , старые» — в названии без пробела перед запятой.
    .replace(/\s+([,.;:!?])/g, "$1");
  const title = clip(rest.charAt(0).toUpperCase() + rest.slice(1), 100);
  if (!title) return null;

  // `\b` в JS видит границы слов только у латиницы, поэтому граница — вручную.
  const word = (value: string) => new RegExp(`(^|[^\\p{L}])${value}([^\\p{L}]|$)`, "iu");
  const tomorrow = word("завтра").test(base);
  const today = !tomorrow && word("сегодня").test(base);
  const due = tomorrow
    ? shiftDay(context.today, 1).toISOString().slice(0, 10)
    : today
      ? context.today
      : null;

  const note = clip(withoutMarks(everything), NOTE_MAX_LENGTH);
  return {
    title,
    note: note && note !== title ? note : null,
    developers,
    unknown: [],
    projectId: null,
    parentId: null,
    dueAt: dueFrom(due, context.today),
    priority: URGENT.test(base) ? "high" : "normal",
    subtasks: [],
  };
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
  const allowParent = Boolean(context.focus) || EXPLICIT_PARENT.test(message);
  return { intent: "task", tasks: toPlan(raw, context, allowParent) };
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
