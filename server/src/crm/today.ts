import type { Client, Lead, Project, Task, User } from "@prisma/client";
import type { CredentialWithProject } from "./credentials/dto.js";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { startOfToday, startOfTomorrow } from "../notify/zone.js";
import { OPEN_LEAD_STATUSES } from "./leads/dto.js";
import { OPEN_PROJECT_STATUSES, PROJECT_RELATIONS, unbilled } from "./projects/dto.js";
import { OPEN_TASK_STATUSES } from "./tasks/dto.js";

/**
 * Один источник правды для «что горит»: и утренний дайджест бота, и экран
 * «Сегодня» показывают одно и то же. Две копии этих запросов разошлись бы за
 * месяц, и человек получал бы в телеграме не то, что видит в браузере.
 *
 * «Сегодня» и «просрочено» считаются календарными сутками в часовом поясе
 * команды, а не 24 часами от текущего момента.
 */

type LeadFull = Lead & {
  owner: Pick<User, "id" | "name" | "email"> | null;
  client: Pick<Client, "id" | "name"> | null;
};

type TaskFull = Task & {
  project: Pick<Project, "id" | "title"> | null;
};

type ProjectFull = Project & {
  client: Pick<Client, "id" | "name"> | null;
  lead: Pick<Lead, "id" | "contact" | "name"> | null;
  tasks: { status: string }[];
};

/**
 * Срез «что горит» — общий для всей команды.
 *
 * Раньше он делился на личный и командный, но личного больше нет: разработчики
 * работают под общим входом и значатся именами, так что «мои задачи» выразить
 * нечем. Один срез вместо двух — и экран с ботом гарантированно показывают
 * одно и то же.
 */
export interface TodaySnapshot {
  leads: {
    /** Срок следующего шага прошёл — у кого угодно. */
    overdue: LeadFull[];
    today: LeadFull[];
    /** Ничьи с наступившим сроком: про них не вспомнит вообще никто. */
    orphanUrgent: LeadFull[];
    /** Пришёл, никто не взял, срок не поставлен. Самое опасное состояние. */
    unclaimed: LeadFull[];
  };
  tasks: {
    overdue: TaskFull[];
    today: TaskFull[];
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
    /** Срок сдачи прошёл или наступает сегодня. */
    urgent: ProjectFull[];
    /** Помесячные, по которым есть неоплаченный пробел — с самого раннего. */
    unbilled: (ProjectFull & { unbilledPeriod: string; unbilledCount: number })[];
  };
}

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

const LEAD_INCLUDE = {
  owner: { select: { id: true, name: true, email: true } },
  client: { select: { id: true, name: true } },
} as const;

const TASK_INCLUDE = {
  project: { select: { id: true, title: true } },
} as const;

export async function collectToday(): Promise<TodaySnapshot> {
  const from = startOfToday(env.TIMEZONE);
  const until = startOfTomorrow(env.TIMEZONE);

  const openLeads = { in: [...OPEN_LEAD_STATUSES] };
  const openTasks = { in: [...OPEN_TASK_STATUSES] };
  const openProjects = { in: [...OPEN_PROJECT_STATUSES] };
  const renewalHorizon = new Date(until.getTime() + RENEWAL_WARNING_DAYS * 86_400_000);
  const renewalUrgentUntil = new Date(until.getTime() + RENEWAL_URGENT_DAYS * 86_400_000);

  const [
    overdueLeads,
    todayLeads,
    orphanUrgent,
    unclaimed,
    overdueTasks,
    todayTasks,
    urgentProjects,
    expiringCredentials,
    monthlyProjects,
  ] = await Promise.all([
    prisma.lead.findMany({
      where: { deletedAt: null, status: openLeads, nextActionAt: { lt: from } },
      orderBy: { nextActionAt: "asc" },
      include: LEAD_INCLUDE,
    }),
    prisma.lead.findMany({
      where: {
        deletedAt: null,
        status: openLeads,
        nextActionAt: { gte: from, lt: until },
      },
      orderBy: { nextActionAt: "asc" },
      include: LEAD_INCLUDE,
    }),
    prisma.lead.findMany({
      where: {
        deletedAt: null,
        status: openLeads,
        ownerId: null,
        nextActionAt: { lt: until },
      },
      orderBy: { nextActionAt: "asc" },
      include: LEAD_INCLUDE,
    }),
    prisma.lead.findMany({
      where: { deletedAt: null, status: "new", ownerId: null, nextActionAt: null },
      orderBy: { createdAt: "asc" },
      include: LEAD_INCLUDE,
    }),
    prisma.task.findMany({
      where: { deletedAt: null, status: openTasks, dueAt: { lt: from } },
      orderBy: { dueAt: "asc" },
      include: TASK_INCLUDE,
    }),
    prisma.task.findMany({
      where: { deletedAt: null, status: openTasks, dueAt: { gte: from, lt: until } },
      orderBy: [{ priority: "desc" }, { position: "asc" }],
      include: TASK_INCLUDE,
    }),
    prisma.project.findMany({
      where: { deletedAt: null, status: openProjects, deadline: { lt: until } },
      orderBy: { deadline: "asc" },
      include: PROJECT_RELATIONS,
    }),
    prisma.credential.findMany({
      include: { project: { select: { id: true, title: true } } },
      where: { deletedAt: null, renewsAt: { lt: renewalHorizon } },
      orderBy: { renewsAt: "asc" },
    }),
    // Пробелы считаются в коде, а не запросом: «нет счёта за любой месяц с
    // начала работ» через SQL выражается плохо, а помесячных проектов у
    // команды десятки, не тысячи. Условие то же, что billingMode === "monthly".
    prisma.project.findMany({
      where: {
        deletedAt: null,
        status: openProjects,
        OR: [{ billingMonthly: true }, { workType: "support" }],
      },
      orderBy: { title: "asc" },
      include: PROJECT_RELATIONS,
    }),
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

  return {
    leads: { overdue: overdueLeads, today: todayLeads, orphanUrgent, unclaimed },
    tasks: { overdue: overdueTasks, today: todayTasks },
    credentials: { urgent: urgentCredentials, later: laterCredentials },
    projects: { urgent: urgentProjects, unbilled: unbilledProjects },
  };
}

/**
 * Общая часть двух проверок ниже: всё, кроме продлений.
 *
 * Продления вынесены, потому что «показывать нечего» и «будить чат незачем» —
 * разные вопросы, и различаются они ровно продлениями.
 */
function hasNothingButCredentials(snapshot: TodaySnapshot): boolean {
  return (
    snapshot.leads.overdue.length === 0 &&
    snapshot.leads.today.length === 0 &&
    snapshot.leads.orphanUrgent.length === 0 &&
    snapshot.leads.unclaimed.length === 0 &&
    snapshot.tasks.overdue.length === 0 &&
    snapshot.tasks.today.length === 0 &&
    snapshot.projects.urgent.length === 0 &&
    snapshot.projects.unbilled.length === 0
  );
}

/**
 * Экрану «Сегодня» показывать нечего — рисуется пустое состояние.
 *
 * Здесь считаются ВСЕ продления, включая далёкие: если человек открыл экран, а
 * там ждёт продление через десять дней, показать его надо, а не писать «всё
 * чисто».
 */
export function isEmptySnapshot(snapshot: TodaySnapshot): boolean {
  return (
    hasNothingButCredentials(snapshot) &&
    snapshot.credentials.urgent.length === 0 &&
    snapshot.credentials.later.length === 0
  );
}

/**
 * Боту незачем писать в чат — он молчит.
 *
 * Отличается от `isEmptySnapshot` одним: далёкие продления поводом не считает.
 * Из-за того, что раньше эти две проверки были одной, единственная запись со
 * сроком через две недели поднимала утреннюю сводку четырнадцать раз подряд, и
 * в каждой была ровно одна строка. Молчание — сигнал, и разменивать его на
 * «через 13 дней» нельзя.
 *
 * Обратного перекоса нет: когда сводка выходит по другому поводу, далёкие
 * продления в неё всё равно попадают — отдельным блоком в самом низу.
 */
export function isQuietSnapshot(snapshot: TodaySnapshot): boolean {
  return hasNothingButCredentials(snapshot) && snapshot.credentials.urgent.length === 0;
}
