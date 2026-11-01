import { api } from "./client";
import type { NoteBrief } from "@/components/note-hint";
import type { Currency } from "@/lib/money";

type Totals = Partial<Record<Currency, number>>;
import type { Note } from "./leads";

export const PROJECT_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "done",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: "Запланирован",
  active: "В работе",
  on_hold: "На паузе",
  done: "Сдан",
  cancelled: "Отменён",
};

export const CLOSED_PROJECT_STATUSES: readonly ProjectStatus[] = ["done", "cancelled"];

/** Как платит проект: этапами, помесячно или никак. Правило живёт на сервере. */
export interface ProjectPayment {
  mode: "stages" | "monthly" | "none";
  stages: {
    paid: number;
    total: number;
    next: { position: number; amountMinor: number | null; currency: Currency } | null;
  } | null;
  /** Счёт за текущий месяц: missing — записи нет. */
  monthly: { period: string; status: "paid" | "unpaid" | "missing" } | null;
}

export interface Project {
  /** Последняя заметка — приходит только в списках. */
  note?: NoteBrief | null;
  id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
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
  /** Минорные единицы: копейки или центы. */
  monthlyAmountMinor: number | null;
  currency: Currency;
  /**
   * Самый ранний месяц без счёта — вида «2026-08», и сколько их всего.
   * Считает сервер: он один знает календарь команды и часовой пояс.
   */
  unbilledPeriod: string | null;
  unbilledCount: number;
  archivedAt: string | null;
  payment: ProjectPayment;

  caseId: string | null;
  openTaskCount: number;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  title?: string;
  description?: string | null;
  status?: ProjectStatus;
  clientId?: string | null;
  leadId?: string | null;
  developers?: string[];
  startedAt?: string | null;
  deadline?: string | null;

  hosting?: string | null;
  workType?: string | null;
  contractNumber?: string | null;
  contractDate?: string | null;
  billingMonthly?: boolean;
  monthlyAmountMinor?: number | null;
  currency?: Currency;
}

/**
 * Виды работ. Копия списка из `server/src/crm/projects/dto.ts` — приложения
 * собираются раздельно. Сервер незнакомое значение не отвергает, так что
 * расхождение проявится только пустой подписью в списке.
 */
export const WORK_TYPES = [
  { value: "contract", label: "Договорной" },
  { value: "oneoff", label: "Разовая работа" },
  { value: "support", label: "Сопровождение" },
  { value: "internal", label: "Свой проект" },
] as const;

const WORK_TYPE_LABELS = new Map<string, string>(
  WORK_TYPES.map((type) => [type.value, type.label]),
);

export function workTypeLabel(value: string | null): string {
  if (!value) return "";
  return WORK_TYPE_LABELS.get(value) ?? value;
}

export type InvoiceKind = "invoice" | "act";

export const INVOICE_KIND_LABELS: Record<InvoiceKind, string> = {
  invoice: "Счёт",
  act: "Акт",
};

export interface Invoice {
  id: string;
  kind: InvoiceKind;
  /** ГГГГ-ММ. */
  period: string;
  amountMinor: number | null;
  currency: Currency;
  issuedAt: string | null;
  paidAt: string | null;
  note: string | null;
}

export interface InvoiceInput {
  kind?: InvoiceKind;
  period?: string;
  amountMinor?: number | null;
  currency?: Currency;
  issuedAt?: string | null;
  paidAt?: string | null;
  note?: string | null;
}

/** Этап договора. Порядок оплаты проверяет сервер, здесь только его ответ. */
export interface Stage {
  id: string;
  position: number;
  amountMinor: number | null;
  currency: Currency;
  issuedAt: string | null;
  paidAt: string | null;
  note: string | null;
  /** Можно отметить оплату. */
  payable: boolean;
  /** Можно снять оплату. */
  unpayable: boolean;
}

export interface StagesResult {
  stages: Stage[];
  totals: Totals;
}

export type StageAmounts = { currency?: Currency } & (
  { totalMinor: number | null } | { amounts: (number | null)[] }
);

export interface StageInput {
  paidAt?: string | null;
  issuedAt?: string | null;
  note?: string | null;
}

export async function getStages(projectId: string): Promise<StagesResult> {
  return api.get<StagesResult>(`/projects/${projectId}/stages`);
}

export async function saveStageAmounts(
  projectId: string,
  input: StageAmounts,
): Promise<StagesResult> {
  return api.put<StagesResult>(`/projects/${projectId}/stages`, input);
}

export async function updateStage(
  projectId: string,
  position: number,
  input: StageInput,
): Promise<{ stage: Stage; stages: Stage[] }> {
  return api.patch<{ stage: Stage; stages: Stage[] }>(
    `/projects/${projectId}/stages/${position}`,
    input,
  );
}

export type BillScope = "due" | "paid" | "all";

/** Строка экрана «Счета»: обычный счёт либо этап договора. */
export interface Bill {
  id: string;
  source: "invoice" | "stage";
  /** ГГГГ-ММ; у этапа null. */
  period: string | null;
  stage: {
    position: number;
    total: number;
    payable: boolean;
    unpayable: boolean;
    /** Какой этап мешает нажать кнопку оплаты. */
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

/**
 * Все счета поверх проектов. Итог считает сервер и по каждой валюте отдельно:
 * складывать рубли с долларами нечем, а выдача может быть обрезана.
 */
export async function listBills(
  scope: BillScope,
): Promise<{ invoices: Bill[]; totals: Totals }> {
  return api.get<{ invoices: Bill[]; totals: Totals }>(`/invoices?scope=${scope}`);
}

export async function listInvoices(projectId: string): Promise<Invoice[]> {
  const { invoices } = await api.get<{ invoices: Invoice[] }>(
    `/projects/${projectId}/invoices`,
  );
  return invoices;
}

export async function createInvoice(
  projectId: string,
  input: InvoiceInput,
): Promise<Invoice> {
  const { invoice } = await api.post<{ invoice: Invoice }>(
    `/projects/${projectId}/invoices`,
    input,
  );
  return invoice;
}

export async function updateInvoice(
  projectId: string,
  invoiceId: string,
  input: InvoiceInput,
): Promise<Invoice> {
  const { invoice } = await api.patch<{ invoice: Invoice }>(
    `/projects/${projectId}/invoices/${invoiceId}`,
    input,
  );
  return invoice;
}

export async function deleteInvoice(projectId: string, invoiceId: string): Promise<void> {
  await api.delete<void>(`/projects/${projectId}/invoices/${invoiceId}`);
}

/** Порядок колонки на доске — целиком, как и у задач. */
export async function reorderProjects(
  status: ProjectStatus,
  ids: string[],
): Promise<void> {
  await api.put<void>("/projects/reorder", { status, ids });
}

export interface ProjectFilters {
  status?: ProjectStatus;
  scope?: "open" | "closed" | "all";
  clientId?: string;
  developer?: string;
  overdue?: boolean;
  search?: string;
}

function toQuery(filters: ProjectFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.clientId) params.set("clientId", filters.clientId);
  if (filters.developer) params.set("developer", filters.developer);
  if (filters.overdue) params.set("overdue", "true");
  if (filters.search) params.set("search", filters.search);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listProjects(filters: ProjectFilters = {}): Promise<Project[]> {
  const { projects } = await api.get<{ projects: Project[] }>(
    `/projects${toQuery(filters)}`,
  );
  return projects;
}

export async function getProject(
  id: string,
): Promise<{ project: Project; notes: Note[] }> {
  return api.get<{ project: Project; notes: Note[] }>(`/projects/${id}`);
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const { project } = await api.post<{ project: Project }>("/projects", input);
  return project;
}

export async function updateProject(id: string, input: ProjectInput): Promise<Project> {
  const { project } = await api.patch<{ project: Project }>(`/projects/${id}`, input);
  return project;
}

export async function deleteProject(id: string): Promise<void> {
  await api.delete<void>(`/projects/${id}`);
}

export async function addProjectNote(projectId: string, body: string): Promise<Note> {
  const { note } = await api.post<{ note: Note }>(`/projects/${projectId}/notes`, {
    body,
  });
  return note;
}
