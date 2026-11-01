import type { Prisma, Project, Task } from "@prisma/client";
import type { CredentialWithProject } from "./credentials/dto.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { startOfToday, startOfTomorrow } from "../notify/zone.js";
import type { Developer } from "./developers.js";
import { listBills, type BillDto } from "./projects/bills.js";
import { OPEN_PROJECT_STATUSES, PROJECT_RELATIONS, unbilled } from "./projects/dto.js";
import { OPEN_TASK_STATUSES } from "./tasks/dto.js";

/**
 * Один источник правды для «что горит»: и утренний дайджест бота, и экран
 * «Сегодня» показывают одно и то же. Две копии этих запросов разошлись бы за
 * месяц, и человек получал бы в телеграме не то, что видит в браузере.
 *
 * «Сегодня» и «просрочено» считаются календарными сутками в часовом поясе
 * команды, а не 24 часами от текущего момента.
 *
 * Архивные проекты сюда не попадают нигде: ни сами, ни их задачи. Продления
 * доступов — намеренно попадают: сайт архивного проекта продолжает работать.
 */

type TaskFull = Task & {
  project: Pick<Project, "id" | "title"> | null;
};

type ProjectFull = Prisma.ProjectGetPayload<{ include: typeof PROJECT_RELATIONS }>;

/**
 * Срез «что горит» — общий для всей команды.
 *
 * Раньше он делился на личный и командный, но личного нет: исполнители значатся
 * именами, а не учётками, так что «мои задачи» выразить нечем. Вместо этого
 * экран может попросить срез по имени (`collectToday({ developer })`), а бот
 * всегда берёт общий.
 */
export interface TodaySnapshot {
  tasks: {
    overdue: TaskFull[];
    today: TaskFull[];
    /** todo/in_progress без исполнителей, которых ещё нет в двух списках выше. */
    unassigned: TaskFull[];
  };
  /**
   * Сервисы, которые пора продлевать. Заглядывать на две недели вперёд, а не
   * ждать самого дня: домен или хостинг оплачиваются не мгновенно, а истёкший
   * в субботу домен — это упавший сайт.
   *
   * Разделены на две очереди, потому что у среза два потребителя с разными
   * запросами. Экран «Сегодня» человек открыл сам и хочет видеть весь горизонт.
   * Утреннее сообщение в чат приходит без спроса и называется «Что горит» —
   * туда далёкое продление не тянет.
   */
  credentials: {
    /** Истекло, сегодня или в ближайшие дни — про такое будим чат. */
    urgent: CredentialWithProject[];
    /** Остаток двухнедельного окна: показать на экране, но не будить. */
    later: CredentialWithProject[];
  };
  projects: {
    /** Срок сдачи прошёл или наступает сегодня. Поднимает дайджест. */
    urgent: ProjectFull[];
    /** Срок в ближайшие дни. Только на экране: бот про такое не будит. */
    soon: ProjectFull[];
    /** Помесячные, по которым есть неоплаченный пробел — с самого раннего. */
    unbilled: (ProjectFull & { unbilledPeriod: string; unbilledCount: number })[];
  };
  money: {
    /** Счёт висит дольше UNPAID_URGENT_DAYS. Поднимает дайджест. */
    unpaidUrgent: BillDto[];
    unpaidLater: BillDto[];
    /** Следующий неоплаченный этап каждого договора. Сводку не поднимает. */
    nextStages: BillDto[];
  };
}

/** Фильтр отвечает на «что на мне»; без него — вся команда. */
export interface TodayFilter {
  developer?: Developer;
}

const DAY_MS = 86_400_000;

/** Сколько дней вперёд проект считается «скоро». */
const PROJECT_SOON_DAYS = 7;

/**
 * С какого возраста неоплаченный счёт поднимает сводку. Свежий счёт — обычное
 * дело: клиент платит не в тот же день, и напоминать о нём бессмысленно.
 */
const UNPAID_URGENT_DAYS = 14;

/** За сколько дней продление вообще попадает в срез. */
const RENEWAL_WARNING_DAYS = 14;

/**
 * За сколько дней продление считается горящим.
 *
 * Двух недель хватает, чтобы успеть оплатить, но эти же две недели раньше
 * заставляли бота писать в чат каждое утро подряд из-за одной записи — а
 * сообщение при этом состояло из единственной строки «через 13 дней». Ровно
 * то, от чего оберегает правило молчания в `digest.ts`: ежедневная сводка ни о
 * чём приучает не открывать бота.
 *
 * Три дня — это ещё запас (пятничное продление видно в среду), но уже такой
 * срок, когда бездействие стоит денег или лежащего сайта.
 */
const RENEWAL_URGENT_DAYS = 3;

const TASK_INCLUDE = {
  project: { select: { id: true, title: true } },
} as const;

export async function collectToday(filter: TodayFilter = {}): Promise<TodaySnapshot> {
  const { developer } = filter;
  const from = startOfToday(env.TIMEZONE);
  const until = startOfTomorrow(env.TIMEZONE);

  const openTasks = { in: [...OPEN_TASK_STATUSES] };
  const renewalHorizon = new Date(until.getTime() + RENEWAL_WARNING_DAYS * DAY_MS);
  const renewalUrgentUntil = new Date(until.getTime() + RENEWAL_URGENT_DAYS * DAY_MS);
  const soonUntil = new Date(until.getTime() + PROJECT_SOON_DAYS * DAY_MS);
  const unpaidUrgentBefore = new Date(from.getTime() - UNPAID_URGENT_DAYS * DAY_MS);

  const onDeveloper = developer ? { developers: { has: developer } } : {};

  // Задача архивного проекта остаётся на экране «Задачи», но никого не торопит.
  // В AND, потому что OR по сроку стоит рядом и иначе перезаписал бы это условие.
  const liveTask: Prisma.TaskWhereInput = {
    deletedAt: null,
    AND: [{ OR: [{ projectId: null }, { project: { archivedAt: null } }] }],
  };
  const liveProject: Prisma.ProjectWhereInput = {
    deletedAt: null,
    archivedAt: null,
    status: { in: [...OPEN_PROJECT_STATUSES] },
    ...onDeveloper,
  };

  const [
    overdueTasks,
    todayTasks,
    unassignedTasks,
    urgentProjects,
    soonProjects,
    expiringCredentials,
    monthlyProjects,
    dueBills,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { ...liveTask, ...onDeveloper, status: openTasks, dueAt: { lt: from } },
      orderBy: { dueAt: "asc" },
      include: TASK_INCLUDE,
    }),
    prisma.task.findMany({
      where: {
        ...liveTask,
        ...onDeveloper,
        status: openTasks,
        dueAt: { gte: from, lt: until },
      },
      orderBy: [{ priority: "desc" }, { position: "asc" }],
      include: TASK_INCLUDE,
    }),
    // Ничьи: фильтр отвечает на «что на мне», а на человеке их нет по определению.
    // Бэклог не входит: «когда-нибудь» без исполнителя — норма, иначе блок не
    // опустел бы никогда. Срочные ничьи уже стоят в двух списках выше.
    developer
      ? []
      : prisma.task.findMany({
          where: {
            ...liveTask,
            developers: { isEmpty: true },
            status: { in: ["todo", "in_progress"] },
            OR: [{ dueAt: null }, { dueAt: { gte: until } }],
          },
          orderBy: [{ priority: "desc" }, { position: "asc" }],
          include: TASK_INCLUDE,
        }),
    prisma.project.findMany({
      where: { ...liveProject, deadline: { lt: until } },
      orderBy: { deadline: "asc" },
      include: PROJECT_RELATIONS,
    }),
    prisma.project.findMany({
      where: { ...liveProject, deadline: { gte: until, lt: soonUntil } },
      orderBy: { deadline: "asc" },
      include: PROJECT_RELATIONS,
    }),
    prisma.credential.findMany({
      include: { project: { select: { id: true, title: true } } },
      where: {
        deletedAt: null,
        renewsAt: { lt: renewalHorizon },
        // Владелец доступа — свободная строка, поэтому без учёта регистра.
        ...(developer && { owner: { equals: developer, mode: "insensitive" } }),
      },
      orderBy: { renewsAt: "asc" },
    }),
    // Пробелы считаются в коде, а не запросом: «нет счёта за любой месяц с
    // начала работ» через SQL выражается плохо, а помесячных проектов у
    // команды десятки, не тысячи. Условие то же, что в `unbilled()`: проект в
    // работе, billingMode === "monthly".
    prisma.project.findMany({
      where: {
        ...liveProject,
        status: "active",
        OR: [{ billingMonthly: true }, { workType: "support" }],
      },
      orderBy: { title: "asc" },
      include: PROJECT_RELATIONS,
    }),
    listBills("due", { developer, activeOnly: true }),
  ]);

  const unbilledProjects = monthlyProjects
    .map((project) => ({
      ...project,
      ...unbilled(project, project.invoices, env.TIMEZONE),
    }))
    .filter(
      (project): project is (typeof monthlyProjects)[number] & {
        period: string;
        count: number;
      } => project.period !== null,
    )
    .map(({ period, count, ...project }) => ({
      ...project,
      unbilledPeriod: period,
      unbilledCount: count,
    }));

  /*
   * Делим уже выбранное, а не вторым запросом: горящие — подмножество
   * двухнедельного окна, и второй поход в базу за тем же самым только даёт
   * шанс разъехаться. Выборка отсортирована по сроку, поэтому обе очереди
   * сохраняют порядок «сначала ближайшее».
   */
  const urgentCredentials: CredentialWithProject[] = [];
  const laterCredentials: CredentialWithProject[] = [];
  for (const item of expiringCredentials) {
    // Без срока продления записи в выборку не попадают, но тип это допускает;
    // такую считаем горящей, чтобы она не потерялась молча.
    const urgent = !item.renewsAt || item.renewsAt < renewalUrgentUntil;
    (urgent ? urgentCredentials : laterCredentials).push(item);
  }

  // Этапы отдельно: договор платится по плану, и следующий этап — не долг, а
  // счёт старше двух недель — уже он. Порядок «старые сверху» задаёт `listBills`.
  const unpaidUrgent: BillDto[] = [];
  const unpaidLater: BillDto[] = [];
  const nextStages: BillDto[] = [];
  for (const bill of dueBills) {
    if (bill.source === "stage") {
      nextStages.push(bill);
      continue;
    }
    const since = new Date(bill.issuedAt ?? bill.createdAt);
    (since < unpaidUrgentBefore ? unpaidUrgent : unpaidLater).push(bill);
  }

  return {
    tasks: { overdue: overdueTasks, today: todayTasks, unassigned: unassignedTasks },
    credentials: { urgent: urgentCredentials, later: laterCredentials },
    projects: { urgent: urgentProjects, soon: soonProjects, unbilled: unbilledProjects },
    money: { unpaidUrgent, unpaidLater, nextStages },
  };
}

/**
 * Боту незачем писать в чат — он молчит.
 *
 * Считаются только поводы действовать сегодня. То, что живёт постоянно, сводку не
 * поднимает: следующий этап есть у любого идущего договора, а свежий неоплаченный
 * счёт и проект со сроком на следующей неделе — обычное рабочее состояние. Из-за
 * них бот писал бы каждое утро, а молчание здесь сигнал.
 *
 * Продления то же самое: раньше единственная запись со сроком через две недели
 * поднимала сводку четырнадцать раз подряд, и в каждой была ровно одна строка.
 * Разменивать молчание на «через 13 дней» нельзя.
 *
 * Обратного перекоса нет: когда сводка выходит по другому поводу, такие строки в
 * неё всё равно попадают — справочными блоками в самом низу.
 */
export function isQuietSnapshot(snapshot: TodaySnapshot): boolean {
  return (
    snapshot.tasks.overdue.length === 0 &&
    snapshot.tasks.today.length === 0 &&
    snapshot.tasks.unassigned.length === 0 &&
    snapshot.projects.urgent.length === 0 &&
    snapshot.projects.unbilled.length === 0 &&
    snapshot.credentials.urgent.length === 0 &&
    snapshot.money.unpaidUrgent.length === 0
  );
}

/**
 * Экрану «Сегодня» показывать нечего — рисуется пустое состояние.
 *
 * Здесь считается всё, включая то, что бота не будит: если человек открыл экран,
 * а там ждёт продление через десять дней, показать его надо, а не писать «всё
 * чисто».
 */
export function isEmptySnapshot(snapshot: TodaySnapshot): boolean {
  return (
    isQuietSnapshot(snapshot) &&
    snapshot.projects.soon.length === 0 &&
    snapshot.credentials.later.length === 0 &&
    snapshot.money.unpaidLater.length === 0 &&
    snapshot.money.nextStages.length === 0
  );
}
