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

/** Колонки доски. «Отменена» намеренно не колонка: это исход, а не этап. */
export const BOARD_COLUMNS: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "done",
];

export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Срочно",
};

export interface Task {
  /** Последняя заметка — приходит только в списках. */
  note?: NoteBrief | null;
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: { id: string; title: string } | null;
  /** Заполнен у подзадачи: своего экрана у неё нет, открывается родитель. */
  parentId: string | null;
  /** Прогресс для карточки и строки списка. Удалённые не считаются. */
  subtasks: SubtaskProgress;
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
export interface TaskDetail extends Task {
  subtaskList: Subtask[];
}

/**
 * Описания здесь нет намеренно: поля нет в форме, а сервер принимает его только ради
 * старой вкладки на время выката. CRM не должна его ни затирать, ни присылать.
 */
export interface TaskInput {
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  projectId?: string | null;
  developers?: string[];
  dueAt?: string | null;
}

/** Родителя можно указать только при создании: подзадачи не переезжают. */
export interface NewTaskInput extends TaskInput {
  parentId?: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  scope?: "open" | "closed" | "all";
  projectId?: string;
  developer?: string;
  standalone?: boolean;
  overdue?: boolean;
  search?: string;
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

export async function createTask(input: NewTaskInput): Promise<Task> {
  const { task } = await api.post<{ task: Task }>("/tasks", input);
  return task;
}

export async function updateTask(id: string, input: TaskInput): Promise<Task> {
  const { task } = await api.patch<{ task: Task }>(`/tasks/${id}`, input);
  return task;
}

export async function deleteTask(id: string): Promise<void> {
  await api.delete<void>(`/tasks/${id}`);
}

/** Порядок колонки целиком: частично применённая перестановка выглядит как потеря. */
export async function reorderTasks(status: TaskStatus, ids: string[]): Promise<void> {
  await api.put<void>("/tasks/reorder", { status, ids });
}

export async function addTaskNote(taskId: string, body: string): Promise<Note> {
  const { note } = await api.post<{ note: Note }>(`/tasks/${taskId}/notes`, { body });
  return note;
}
