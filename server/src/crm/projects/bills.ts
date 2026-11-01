import type { Currency, Prisma, ProjectStage, ProjectStatus } from "@prisma/client";
import { prisma } from "../../db.js";
import { billingMode } from "./dto.js";
import { toStageDto } from "./stages.js";

/**
 * «Кто, когда и за что платит». Единственное место, которое знает, что счёт
 * живёт в двух таблицах: `invoices` (помесячные и разовые) и `project_stages`
 * (этапы договора). Экран «Счета» и «Сегодня» читают только этот модуль.
 *
 * Акты сюда не входят: экран про деньги, а акты остаются в карточке проекта.
 */

export interface BillDto {
  id: string;
  source: "invoice" | "stage";
  /** ГГГГ-ММ; у этапа null. */
  period: string | null;
  stage: {
    position: number;
    total: number;
    payable: boolean;
    unpayable: boolean;
    /** Какой этап мешает нажать кнопку оплаты: предыдущий или, при снятии, следующий. */
    blockedBy: number | null;
  } | null;
  amountMinor: number | null;
  currency: Currency;
  issuedAt: string | null;
  paidAt: string | null;
  note: string | null;
  createdAt: string;
  project: {
    id: string;
    title: string;
    status: ProjectStatus;
    archived: boolean;
    developers: string[];
    client: string | null;
    clientId: string | null;
  };
}

export type BillScope = "due" | "paid" | "all";

const BILL_PROJECT = {
  id: true,
  title: true,
  status: true,
  archivedAt: true,
  developers: true,
  workType: true,
  billingMonthly: true,
  client: { select: { id: true, name: true } },
} as const;

type BillProject = Prisma.ProjectGetPayload<{ select: typeof BILL_PROJECT }>;

function toBillProject(project: BillProject): BillDto["project"] {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    archived: project.archivedAt !== null,
    developers: project.developers,
    client: project.client?.name ?? null,
    clientId: project.client?.id ?? null,
  };
}

/** Одно правило на все срезы: какой этап вообще считается счётом. */
function stageVisible(stage: ProjectStage, project: BillProject): boolean {
  // Оплата — это история, она видна всегда.
  if (stage.paidAt) return true;
  // Ушли с договора или платят помесячно: этапы есть, но счетами не являются.
  if (billingMode(project) !== "stages") return false;
  // Отменённый проект никому ничего не должен.
  if (project.status === "cancelled") return false;
  // Пустые этапы, созданные миграцией у давно закрытых договоров. Сданный проект
  // с названной суммой остаётся: неоплаченный финальный этап — настоящий долг.
  if (project.status === "done" && stage.amountMinor === null) return false;
  return true;
}

function stageBills(
  project: BillProject & { stages: ProjectStage[] },
  scope: BillScope,
): BillDto[] {
  const mode = billingMode(project);
  const visible = project.stages.filter((stage) => stageVisible(stage, project));

  // Только следующий этап — не упрощение: второй нельзя оплатить раньше первого,
  // а три этапа разом завысили бы долг на всю сумму договора.
  const picked =
    scope === "due"
      ? visible.filter((stage) => !stage.paidAt).slice(0, 1)
      : scope === "paid"
        ? visible.filter((stage) => stage.paidAt)
        : visible;

  return picked.map((stage) => {
    const { payable, unpayable } = toStageDto(stage, project.stages, mode);
    const previous = project.stages.find((it) => it.position === stage.position - 1);
    const next = project.stages.find((it) => it.position === stage.position + 1);
    const blocker = stage.paidAt
      ? next?.paidAt
        ? next
        : null
      : previous && !previous.paidAt
        ? previous
        : null;

    return {
      id: stage.id,
      source: "stage",
      period: null,
      stage: {
        position: stage.position,
        total: project.stages.length,
        payable,
        unpayable,
        blockedBy: blocker?.position ?? null,
      },
      amountMinor: stage.amountMinor,
      currency: stage.currency,
      issuedAt: stage.issuedAt?.toISOString() ?? null,
      paidAt: stage.paidAt?.toISOString() ?? null,
      note: stage.note,
      createdAt: stage.createdAt.toISOString(),
      project: toBillProject(project),
    };
  });
}

const ORDER: Record<BillScope, (a: BillDto, b: BillDto) => number> = {
  // Старые долги сверху.
  due: (a, b) => compare(a.issuedAt ?? a.createdAt, b.issuedAt ?? b.createdAt),
  // Свежая оплата сверху.
  paid: (a, b) => compare(b.paidAt ?? b.createdAt, a.paidAt ?? a.createdAt),
  all: (a, b) => compare(b.createdAt, a.createdAt),
};

/** Даты здесь — ISO-строки в UTC, они сравниваются как текст. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Запросы намеренно без `take`: видимость и «первый неоплаченный» считает код,
 * поэтому `take` срезал бы этапы до фильтра, а итог по обрезанному занизил бы
 * долг. Обрезать можно только готовый список. Строк здесь сотни, а не миллионы.
 */
export async function listBills(
  scope: BillScope,
  options: { developer?: string; activeOnly?: boolean } = {},
): Promise<BillDto[]> {
  const project: Prisma.ProjectWhereInput = {
    deletedAt: null,
    ...(options.developer && { developers: { has: options.developer } }),
    ...(options.activeOnly && { archivedAt: null, status: { not: "cancelled" } }),
  };

  const [invoices, projects] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        kind: "invoice",
        project,
        ...(scope === "due" && { paidAt: null }),
        ...(scope === "paid" && { paidAt: { not: null } }),
      },
      include: { project: { select: BILL_PROJECT } },
    }),
    prisma.project.findMany({
      where: { ...project, stages: { some: {} } },
      select: { ...BILL_PROJECT, stages: { orderBy: { position: "asc" } } },
    }),
  ]);

  const bills: BillDto[] = [
    ...invoices.map((invoice): BillDto => ({
      id: invoice.id,
      source: "invoice",
      period: invoice.period,
      stage: null,
      amountMinor: invoice.amountMinor,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      note: invoice.note,
      createdAt: invoice.createdAt.toISOString(),
      project: toBillProject(invoice.project),
    })),
    ...projects.flatMap((item) => stageBills(item, scope)),
  ];

  return bills.sort(ORDER[scope]);
}
