import { useSyncExternalStore } from "react";
import { api } from "./client";

/**
 * Колонки досок. Название и порядок задаёт админ, а тип (`kind`) — это статус, который
 * получают карточки колонки: на него смотрят «Сегодня», сводка, счета. Подробно —
 * `server/src/crm/columns/columns.ts`.
 */
export type ColumnScope = "task" | "project";

export interface BoardColumnDef {
  id: string;
  scope: ColumnScope;
  title: string;
  kind: string;
  position: number;
}

/** Подписи типов для формы новой колонки: что колонка значит для системы. */
export const COLUMN_KIND_LABELS: Record<ColumnScope, Record<string, string>> = {
  task: { todo: "Ждёт", in_progress: "В работе", done: "Готово" },
  project: {
    planned: "Запланирован",
    active: "В работе",
    on_hold: "На паузе",
    done: "Сдан",
    cancelled: "Отменён",
  },
};

export const COLUMN_KIND_HINTS: Record<ColumnScope, Record<string, string>> = {
  task: {
    todo: "Ещё не начата: попадает в «Сегодня» по сроку",
    in_progress: "Идёт работа",
    done: "Закрыта: уходит из «Сегодня» и сводки",
  },
  project: {
    planned: "Ещё не начат, счета не выставляются",
    active: "Идёт работа, ежемесячные счета выставляются",
    on_hold: "Ждём клиента или оплату, счета не выставляются",
    done: "Закрыт, работа сдана",
    cancelled: "Закрыт без результата",
  },
};

let cache: BoardColumnDef[] | null = null;
let pending: Promise<BoardColumnDef[]> | null = null;
/** Пауза после сбоя: иначе каждая перерисовка экрана слала бы новый запрос. */
const RETRY_MS = 15_000;
let failedAt = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Список один на вкладку: колонки нужны двум доскам, форме и строкам списков. */
export function loadColumns(force = false): Promise<BoardColumnDef[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (pending && !force) return pending;
  const request = api
    .get<{ columns: BoardColumnDef[] }>("/board-columns")
    .then(({ columns }) => {
      cache = columns;
      failedAt = 0;
      emit();
      return columns;
    })
    .catch((cause: unknown) => {
      // Сеть моргнула: доска подождёт и спросит ещё раз сама, без перезагрузки.
      failedAt = Date.now();
      setTimeout(() => void loadColumns().catch(() => undefined), RETRY_MS);
      throw cause;
    })
    .finally(() => {
      if (pending === request) pending = null;
    });
  pending = request;
  return request;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Колонки доски по порядку; `null`, пока не загрузились. */
export function useColumns(scope: ColumnScope): BoardColumnDef[] | null {
  const all = useSyncExternalStore(subscribe, () => cache);
  if (all === null) {
    if (Date.now() - failedAt >= RETRY_MS) void loadColumns().catch(() => undefined);
    return null;
  }
  return all.filter((column) => column.scope === scope);
}

/**
 * Колонка карточки. Своя, если она есть и того же типа, что статус; иначе первая колонка
 * типа. Так карточка не теряется, если колонку удалили в другой вкладке или статус
 * поменяла старая форма. Отменённая задача колонки не имеет.
 */
export function columnOf(
  columns: BoardColumnDef[],
  item: { columnId?: string | null; status: string },
): BoardColumnDef | null {
  const status = item.status === "backlog" ? "todo" : item.status;
  const own = columns.find((column) => column.id === item.columnId);
  if (own && own.kind === status) return own;
  return columns.find((column) => column.kind === status) ?? null;
}

export async function createColumn(input: {
  scope: ColumnScope;
  title: string;
  kind: string;
}): Promise<BoardColumnDef> {
  const { column } = await api.post<{ column: BoardColumnDef }>("/board-columns", input);
  await loadColumns(true);
  return column;
}

export async function renameColumn(id: string, title: string): Promise<void> {
  await api.patch(`/board-columns/${id}`, { title });
  await loadColumns(true);
}

export async function reorderColumns(scope: ColumnScope, ids: string[]): Promise<void> {
  await api.put("/board-columns/order", { scope, ids });
  await loadColumns(true);
}

export async function deleteColumn(
  id: string,
): Promise<{ movedTo: BoardColumnDef; moved: number }> {
  const result = await api.delete<{ movedTo: BoardColumnDef; moved: number }>(
    `/board-columns/${id}`,
  );
  await loadColumns(true);
  return result;
}
