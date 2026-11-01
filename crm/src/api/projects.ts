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

/** Счёт вместе с проектом, к которому относится, — для сквозного списка. */
export interface InvoiceWithProject extends Invoice {
  project: { id: string; title: string; client: string | null };
}

/**
 * Все счета поверх проектов. Без этого «кто нам должен» отвечается только
 * обходом каждого проекта по очереди — то есть не отвечается.
 */
export async function listAllInvoices(
  scope: "unpaid" | "all" = "unpaid",
): Promise<{ invoices: InvoiceWithProject[]; totals: Totals }> {
  // Итог по каждой валюте отдельно: складывать рубли с долларами нечем.
  return api.get<{ invoices: InvoiceWithProject[]; totals: Totals }>(
    `/invoices?scope=${scope}`,
  );
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
