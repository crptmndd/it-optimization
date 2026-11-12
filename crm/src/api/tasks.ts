import { api } from "./client";
import type { NoteBrief } from "@/components/note-hint";
import type { Note } from "./leads";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Когда-нибудь",
  todo: "К работе",
  in_progress: "В работе",
  done: "Готово",
  cancelled: "Отменена",
};

export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/**
 * От низкой к срочной: на этом порядке стоит сортировка. `high` значит «Срочно», значение
 * старше четырёх уровней и осталось прежним, а «Высокая» — это `important` перед ним.
 */
export const TASK_PRIORITIES = ["low", "normal", "important", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Низкая",
  normal: "Обычная",
  important: "Высокая",
  high: "Срочно",
};

export interface Task {
  /** Последняя заметка — приходит только в списках. */
  note?: NoteBrief | null;
  id: string;
  title: string;
  status: TaskStatus;
  /**
   * Колонка доски, статус — её тип. Пусто у подзадачи и отменённой. Нестрого: CRM уезжает
   * раньше, чем API на старом коде успевает смениться, и поля может не быть совсем.
   */
  columnId?: string | null;
  /** В архиве — сама (закрыта больше трёх дней назад) или руками: на доске её нет. */
  archived?: boolean;
  /** Когда админ убрал её в архив руками. Пусто — не убирали. */
  archivedAt?: string | null;
  priority: TaskPriority;
  project: { id: string; title: string } | null;
  /** Заполнен у подзадачи: своего экрана у неё нет, открывается родитель. */
  parentId: string | null;
  /** Прогресс для карточки и строки списка. Удалённые не считаются. */
  subtasks: SubtaskProgress;
  /** Сколько файлов прикреплено. Нет у старого API во время выката. */
  files?: number;
  developers: string[];
  dueAt: string | null;
  completedAt: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubtaskProgress {
  total: number;
  done: number;
}

export interface Subtask {
  id: string;
  title: string;
  status: TaskStatus;
  developers: string[];
  completedAt: string | null;
}

/** Подзадачи целиком приходят только в карточке: на доске хватает прогресса. */
/** Файл к задаче: скриншот, документ. Отдаётся только через API, тем, кому видна задача. */
export interface TaskAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Путь в API: полный адрес даёт `apiUrl`. */
  url: string;
  /** Картинка, которую можно показать миниатюрой. */
  image: boolean;
}

export interface TaskDetail extends Task {
  subtaskList: Subtask[];
  /** Нет у старого API во время выката. */
  attachments?: TaskAttachment[];
}

/**
 * Описания здесь нет намеренно: поля нет в форме, а сервер принимает его только ради
 * старой вкладки на время выката. CRM не должна его ни затирать, ни присылать.
 */
export interface TaskInput {
  title?: string;
  status?: TaskStatus;
  /** Колонка сильнее статуса: сервер возьмёт статус из её типа. */
  columnId?: string | null;
  /** false — не писать о постановке в общий чат. Не хранится, нет поля — пишет. */
  notifyChat?: boolean;
  priority?: TaskPriority;
  projectId?: string | null;
  developers?: string[];
  dueAt?: string | null;
}

/** Родителя можно указать только при создании: подзадачи не переезжают. */
export interface NewTaskInput extends TaskInput {
  parentId?: string;
  /** Первая заметка, сервер заводит её вместе с задачей. У подзадачи заметок нет. */
  note?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  scope?: "open" | "closed" | "all";
  projectId?: string;
  developer?: string;
  standalone?: boolean;
  overdue?: boolean;
  search?: string;
  /** По умолчанию сервер отдаёт всё, архив тоже. */
  archived?: "exclude" | "only" | "include";
}

function toQuery(filters: TaskFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.developer) params.set("developer", filters.developer);
  if (filters.standalone) params.set("standalone", "true");
  if (filters.overdue) params.set("overdue", "true");
  if (filters.search) params.set("search", filters.search);
  if (filters.archived) params.set("archived", filters.archived);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listTasks(filters: TaskFilters = {}): Promise<Task[]> {
  const { tasks } = await api.get<{ tasks: Task[] }>(`/tasks${toQuery(filters)}`);
  return tasks;
}

export interface TaskWithNotes {
  task: TaskDetail;
  notes: Note[];
}

export async function getTask(id: string): Promise<TaskWithNotes> {
  return api.get<TaskWithNotes>(`/tasks/${id}`);
}

export async function uploadTaskAttachment(
  taskId: string,
  file: File,
): Promise<TaskAttachment> {
  const form = new FormData();
  form.append("file", file);
  const { attachment } = await api.upload<{ attachment: TaskAttachment }>(
    `/tasks/${taskId}/attachments`,
    form,
  );
  return attachment;
}

export async function deleteTaskAttachment(taskId: string, id: string): Promise<void> {
  await api.delete(`/tasks/${taskId}/attachments/${id}`);
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  const { task } = await api.post<{ task: Task }>("/tasks", input);
  return task;
}

export async function updateTask(id: string, input: TaskInput): Promise<Task> {
  const { task } = await api.patch<{ task: Task }>(`/tasks/${id}`, input);
  return task;
}

/** Через сколько дней закрытая задача сама уходит в архив. То же число, что на сервере. */
export const ARCHIVE_AFTER_DAYS = 3;

/** Закрыта так давно, что в архиве по возрасту: ручной возврат её не вернёт на доску. */
export function archivedByAge(task: Task): boolean {
  if (task.status !== "done" && task.status !== "cancelled") return false;
  const closed = Date.parse(task.completedAt ?? task.updatedAt);
  return Date.now() - closed > ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

export async function archiveTask(id: string): Promise<Task> {
  const { task } = await api.post<{ task: Task }>(`/tasks/${id}/archive`);
  return task;
}

export async function unarchiveTask(id: string): Promise<Task> {
  const { task } = await api.post<{ task: Task }>(`/tasks/${id}/unarchive`);
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  await api.delete<void>(`/tasks/${id}`);
}

/** Порядок колонки целиком: частично применённая перестановка выглядит как потеря. */
export async function reorderTasks(columnId: string, ids: string[]): Promise<void> {
  await api.put<void>("/tasks/reorder", { columnId, ids });
}

export async function addTaskNote(taskId: string, body: string): Promise<Note> {
  const { note } = await api.post<{ note: Note }>(`/tasks/${taskId}/notes`, { body });
  return note;
}
