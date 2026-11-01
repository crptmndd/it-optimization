import type { Client, Currency, Lead, Project } from "@prisma/client";
import { z } from "zod";
import { DEVELOPERS } from "../developers.js";
import {
  MAX_AMOUNT_MINOR,
  optionalDate,
  optionalText,
  optionalUuid,
  requiredTitle,
} from "../fields.js";

export const PROJECT_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "done",
  "cancelled",
] as const;

/** Идущие: именно они должны попадаться на глаза каждый день. */
export const OPEN_PROJECT_STATUSES = ["planned", "active", "on_hold"] as const;
export const CLOSED_PROJECT_STATUSES = ["done", "cancelled"] as const;

const projectFields = {
  title: requiredTitle(200, "Без названия проект не найти"),
  description: optionalText(4000),
  status: z.enum(PROJECT_STATUSES),
  clientId: optionalUuid,
  leadId: optionalUuid,
  /// Кто ведёт. Список целиком: приходит новый состав, а не «добавь этого».
  /// Частичные операции над множеством порождают гонки, когда двое правят
  /// проект одновременно.
  developers: z.array(z.enum(DEVELOPERS)).max(10),
  startedAt: optionalDate,
  deadline: optionalDate,

  hosting: optionalText(200),
  workType: optionalText(60),
  contractNumber: optionalText(60),
  contractDate: optionalDate,

  billingMonthly: z.boolean(),
  /// Минорные единицы. Отрицательная сумма — почти наверняка опечатка.
  monthlyAmountMinor: z.union([z.null(), z.number().int().min(0).max(MAX_AMOUNT_MINOR)]),
  currency: z.enum(["rub", "usd"]),
};

/**
 * Виды работ. Строка в базе, список здесь — чтобы в интерфейсе был выбор, а не
 * свободное поле: иначе «договорной», «Договор» и «по договору» станут тремя
 * разными видами, и фильтр по ним потеряет смысл. Незнакомое значение при этом
 * не отвергается — список пополняется без миграции.
 */
export const WORK_TYPES = [
  { value: "contract", label: "Договорной" },
  { value: "oneoff", label: "Разовая работа" },
  { value: "support", label: "Сопровождение" },
  { value: "internal", label: "Свой проект" },
] as const;

export const createProjectBody = z
  .object(projectFields)
  .partial()
  .required({ title: true });

export const updateProjectBody = z.object(projectFields).partial();

/** Порядок колонки целиком: частично применённая перестановка выглядит как потеря. */
export const reorderProjectsBody = z.object({
  status: z.enum(PROJECT_STATUSES),
  ids: z.array(z.string().uuid()).max(500),
});

export const invoiceBody = z.object({
  kind: z.enum(["invoice", "act"]),
  /// ГГГГ-ММ. Регулярка, а не дата: это календарный месяц, а не момент.
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Период вида 2026-08"),
  amountMinor: z
    .union([z.null(), z.number().int().min(0).max(MAX_AMOUNT_MINOR)])
    .optional(),
  currency: z.enum(["rub", "usd"]).optional(),
  issuedAt: optionalDate.optional(),
  paidAt: optionalDate.optional(),
  note: optionalText(500).optional(),
});

export const listProjectsQuery = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  scope: z.enum(["open", "closed", "all"]).default("all"),
  /// `none` — проекты без клиента: это и есть очередь на привязку.
  clientId: z.union([z.string().uuid(), z.literal("none")]).optional(),
  /// По умолчанию архива нет: все старые вызовы и доска не видят его сами.
  archived: z.enum(["exclude", "only", "include"]).default("exclude"),
  /// Проекты одного человека — «что на мне висит».
  developer: z.enum(DEVELOPERS).optional(),
  /** Только те, у кого срок уже прошёл, а проект ещё не закрыт. */
  overdue: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  search: z.string().trim().max(200).optional(),
});

/** Как платит проект и что с оплатой сейчас — для карточки, доски и списка. */
export interface ProjectPayment {
  mode: "stages" | "monthly" | "none";
  stages: {
    paid: number;
    total: number;
    next: { position: number; amountMinor: number | null; currency: Currency } | null;
  } | null;
  /** Счёт за текущий месяц: missing — записи нет, а по `unbilled()` она должна быть. */
  monthly: { period: string; status: "paid" | "unpaid" | "missing" } | null;
}

export interface ProjectDto {
  id: string;
  title: string;
  description: string | null;
  status: (typeof PROJECT_STATUSES)[number];
  client: { id: string; name: string } | null;
  lead: { id: string; contact: string; name: string | null } | null;
  developers: string[];
  startedAt: string | null;
  deadline: string | null;
  closedAt: string | null;
  position: number;

  hosting: string | null;
  workType: string | null;
  contractNumber: string | null;
  contractDate: string | null;

  billingMonthly: boolean;
  monthlyAmountMinor: number | null;
  currency: Currency;
  /**
   * Самый ранний месяц без счёта — вида «2026-08», и сколько их всего.
   * Считается на сервере: клиенту иначе пришлось бы знать про календарь
   * команды и часовой пояс. `null` — либо счета не помесячные, либо всё
   * выставлено.
   */
  unbilledPeriod: string | null;
  unbilledCount: number;
  archivedAt: string | null;
  payment: ProjectPayment;
  /** Есть ли уже кейс на сайте — из этого растёт кнопка публикации. */
  caseId: string | null;
  openTaskCount: number;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

type ProjectWithRelations = Project & {
  client: Pick<Client, "id" | "name"> | null;
  lead: Pick<Lead, "id" | "contact" | "name"> | null;
  tasks?: { status: string }[];
  invoices?: { kind: string; period: string; paidAt?: Date | null }[];
  stages?: {
    position: number;
    amountMinor: number | null;
    currency: Currency;
    paidAt: Date | null;
  }[];
};

/**
 * Единственное правило «как платит проект». На нём стоят карточка, видимость
 * этапов в «Счетах», автодокументы, `unbilled()` и проверки оплаты этапов.
 *
 * Галочка сильнее вида работы намеренно. Старая форма позволяла поставить её на
 * договоре, и у таких проектов в базе уже идут помесячные счета, а этапы из
 * миграции пусты. Будь первым договор, автодокументы по ним молча прекратились
 * бы; работай оба способа сразу, один проект показывал бы и счёт за месяц, и
 * «Этап 1 из 3» — то есть один долг дважды.
 */
export function billingMode(project: {
  workType: string | null;
  billingMonthly: boolean;
}): ProjectPayment["mode"] {
  if (project.billingMonthly || project.workType === "support") return "monthly";
  return project.workType === "contract" ? "stages" : "none";
}

/**
 * Значение признака «счёт каждый месяц» после записи.
 *
 * Признак меняется только в момент смены вида работы. Форма присылает и вид
 * работы, и галочку при каждом сохранении, поэтому условие «запрос трогает поле»
 * здесь не работает: обычная правка названия у старого сопровождения включила бы
 * признак, и проект, начатый в январе 2025-го, разом получил бы два десятка
 * месяцев в «Не выставлено».
 *
 * Переход на договор снимает признак: договор платится этапами, и без этого
 * возврат с сопровождения дал бы и этапы, и помесячные счета. Старый договор с
 * галочкой при обычном сохранении её сохраняет: режим меняет только человек.
 */
export function nextBillingMonthly(
  input: { workType?: string | null; billingMonthly?: boolean },
  existing?: { workType: string | null; billingMonthly: boolean },
): boolean {
  const workType =
    input.workType !== undefined ? input.workType : (existing?.workType ?? null);
  const changed = workType !== (existing?.workType ?? null);
  const flag = input.billingMonthly ?? existing?.billingMonthly ?? false;
  if (workType === "support") return changed || existing?.billingMonthly || flag;
  if (workType === "contract" && changed) return false;
  return flag;
}

/** Месяц как ГГГГ-ММ в часовом поясе команды. */
export function currentPeriod(timeZone: string, now = new Date()): string {
  // en-CA даёт «2026-08» — ровно нужный порядок.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).format(now);
}

/** Все месяцы от начального до текущего включительно. */
function periodsBetween(from: string, to: string): string[] {
  const [fromYear = 0, fromMonth = 1] = from.split("-").map(Number);
  const [toYear = 0, toMonth = 1] = to.split("-").map(Number);

  const result: string[] = [];
  let year = fromYear;
  let month = fromMonth;
  // Ограничение сверху: порченая дата начала не должна крутить цикл вечно.
  while ((year < toYear || (year === toYear && month <= toMonth)) && result.length < 120) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

/**
 * Самый ранний месяц, за который счёта нет, и сколько таких месяцев всего.
 *
 * Раньше проверялся только текущий месяц — и забытый февраль не всплывал уже
 * никогда: в апреле система смотрела на апрель. Проект, не выставленный три
 * месяца, выглядел ровно как выставленный вчера. Считаем от начала работ.
 *
 * Считаются только проекты в статусе «В работе»: автодокументы делаются для них же,
 * поэтому список совпадает с тем, что система обязана выставлять. Иначе проект из
 * «Запланирован», статуса по умолчанию, поднимал бы утреннюю сводку каждый день.
 */
export function unbilled(
  project: {
    status: string;
    billingMonthly: boolean;
    workType: string | null;
    archivedAt: Date | null;
    startedAt: Date | null;
    createdAt: Date;
  },
  invoices: { kind: string; period: string }[],
  timeZone: string,
): { period: string | null; count: number } {
  if (
    project.archivedAt ||
    project.status !== "active" ||
    billingMode(project) !== "monthly"
  ) {
    return { period: null, count: 0 };
  }

  const issued = new Set(
    invoices.filter((invoice) => invoice.kind === "invoice").map((it) => it.period),
  );
  const to = currentPeriod(timeZone);
  const started = currentPeriod(timeZone, project.startedAt ?? project.createdAt);
  // Старое сопровождение без галочки считается от своей первой записи, а не от
  // начала работ: месяцы до автодокументов в CRM не велись, зажигать их незачем.
  // Записей нет — значит, проект стал подходящим уже после запуска за этот месяц, и
  // пропуском считается текущий: иначе месяц терялся бы молча.
  const first = [...issued].sort()[0];
  const from = project.billingMonthly
    ? started
    : (first ?? (started > to ? started : to));

  const missing = periodsBetween(from, to).filter((period) => !issued.has(period));
  return { period: missing[0] ?? null, count: missing.length };
}

function projectPayment(item: ProjectWithRelations, timeZone: string): ProjectPayment {
  const mode = billingMode(item);

  if (mode === "stages") {
    const stages = item.stages ?? [];
    const next = stages.find((stage) => !stage.paidAt);
    return {
      mode,
      stages: {
        paid: stages.filter((stage) => stage.paidAt).length,
        total: stages.length,
        next: next
          ? {
              position: next.position,
              amountMinor: next.amountMinor,
              currency: next.currency,
            }
          : null,
      },
      monthly: null,
    };
  }

  if (mode === "monthly" && !item.archivedAt) {
    const period = currentPeriod(timeZone);
    const invoice = item.invoices?.find(
      (it) => it.kind === "invoice" && it.period === period,
    );
    if (invoice) {
      const status = invoice.paidAt ? "paid" : "unpaid";
      return { mode, stages: null, monthly: { period, status } };
    }

    // «Нет счёта» только там, где счёт обязан был появиться: то же правило, что в
    // `unbilled()`. Иначе у проекта, который ещё не в работе или стартует позже, рядом
    // с пустым «Не выставлено» горела бы красная подпись.
    const started = !item.startedAt || currentPeriod(timeZone, item.startedAt) <= period;
    if (item.status === "active" && started) {
      return { mode, stages: null, monthly: { period, status: "missing" } };
    }
  }

  return { mode, stages: null, monthly: null };
}

export function toProjectDto(item: ProjectWithRelations, timeZone: string): ProjectDto {
  const tasks = item.tasks ?? [];
  // Акты в расчёт не входят: напоминание про деньги, а не про документы.
  const missing = unbilled(item, item.invoices ?? [], timeZone);
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    client: item.client ? { id: item.client.id, name: item.client.name } : null,
    lead: item.lead
      ? { id: item.lead.id, contact: item.lead.contact, name: item.lead.name }
      : null,
    developers: item.developers,
    startedAt: item.startedAt?.toISOString() ?? null,
    deadline: item.deadline?.toISOString() ?? null,
    closedAt: item.closedAt?.toISOString() ?? null,
    position: item.position,
    hosting: item.hosting,
    workType: item.workType,
    contractNumber: item.contractNumber,
    contractDate: item.contractDate?.toISOString() ?? null,
    billingMonthly: item.billingMonthly,
    monthlyAmountMinor: item.monthlyAmountMinor,
    currency: item.currency,
    unbilledPeriod: missing.period,
    unbilledCount: missing.count,
    archivedAt: item.archivedAt?.toISOString() ?? null,
    payment: projectPayment(item, timeZone),
    caseId: item.caseId,
    openTaskCount: tasks.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ).length,
    taskCount: tasks.length,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export const PROJECT_RELATIONS = {
  client: { select: { id: true, name: true } },
  lead: { select: { id: true, contact: true, name: true } },
  tasks: { where: { deletedAt: null }, select: { status: true } },
  // Без сумм: для списка они не нужны, а строк на проект за год набегает две
  // дюжины. Отметка оплаты нужна состоянию оплаты за текущий месяц.
  invoices: { select: { kind: true, period: true, paidAt: true } },
  stages: {
    orderBy: { position: "asc" },
    select: { position: true, amountMinor: true, currency: true, paidAt: true },
  },
} as const;
