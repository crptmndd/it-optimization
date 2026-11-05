import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";

/**
 * Колонки досок задач и проектов.
 *
 * Название и порядок колонок задаёт админ, а `kind` говорит системе, что колонка значит:
 * это статус, который получают её карточки. Вся логика по-прежнему смотрит на статус
 * («Сегодня», сводка, счета, закрытие), поэтому три колонки «Дизайн», «Вёрстка» и
 * «На проверке» с типом «В работе» для неё одинаковы, а для человека разные.
 *
 * Тип колонки задаётся при создании и дальше не меняется: смена переставила бы статус
 * всем её карточкам, а у проекта статус включает и выключает счета. Последнюю колонку
 * своего типа удалить нельзя, поэтому у любого статуса всегда есть куда встать.
 */
export const COLUMN_SCOPES = ["task", "project"] as const;
export type ColumnScope = (typeof COLUMN_SCOPES)[number];

/**
 * Какие статусы бывают колонками. «Отменена» у задачи — исход, а не этап, поэтому её
 * колонки нет, как не было и раньше. «Когда-нибудь» убрано по просьбе владельца:
 * такие задачи переехали в «К работе», а старая вкладка, приславшая `backlog`, тоже
 * попадает туда (`normalizeTaskStatus`).
 */
export const COLUMN_KINDS = {
  task: ["todo", "in_progress", "done"],
  project: ["planned", "active", "on_hold", "done", "cancelled"],
} as const satisfies Record<ColumnScope, readonly string[]>;

export type ColumnKind<S extends ColumnScope> = (typeof COLUMN_KINDS)[S][number];

export interface ColumnDto {
  id: string;
  scope: ColumnScope;
  title: string;
  kind: string;
  position: number;
}

export function toColumnDto(column: {
  id: string;
  scope: string;
  title: string;
  kind: string;
  position: number;
}): ColumnDto {
  return {
    id: column.id,
    scope: column.scope as ColumnScope,
    title: column.title,
    kind: column.kind,
    position: column.position,
  };
}

export function isColumnKind(scope: ColumnScope, kind: string): boolean {
  return (COLUMN_KINDS[scope] as readonly string[]).includes(kind);
}

/** Старая вкладка во время выката ещё умеет `backlog`: такой колонки больше нет. */
export function normalizeTaskStatus<T extends string | undefined>(status: T): T {
  return (status === "backlog" ? "todo" : status) as T;
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Первая по порядку колонка типа: туда встаёт карточка, у которой сменили только статус. */
export async function firstColumnOf(
  db: Db,
  scope: ColumnScope,
  kind: string,
): Promise<string | null> {
  const column = await db.boardColumn.findFirst({
    where: { scope, kind },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  return column?.id ?? null;
}

export type Placement =
  { ok: true; columnId: string | null; status: string } | { ok: false; error: string };

/**
 * Куда встаёт карточка. Колонка сильнее статуса: из неё статус и берётся. Прислали только
 * статус — карточка встаёт в первую колонку этого типа, а если её колонка уже этого типа,
 * остаётся в ней: смена «В работе» на «В работе» из старой формы не должна выдёргивать
 * задачу из «На проверке». Статус без колонки (отменённая задача) — колонки нет.
 */
export async function placeCard(
  db: Db,
  scope: ColumnScope,
  input: { columnId?: string | null; status?: string },
  current?: { columnId: string | null; status: string },
): Promise<Placement> {
  if (input.columnId) {
    const column = await db.boardColumn.findFirst({
      where: { id: input.columnId, scope },
      select: { id: true, kind: true },
    });
    if (!column) return { ok: false, error: "Колонка не найдена" };
    return { ok: true, columnId: column.id, status: column.kind };
  }

  const status = input.status ?? current?.status;
  if (status === undefined) return { ok: false, error: "Нет статуса" };
  if (!isColumnKind(scope, status)) return { ok: true, columnId: null, status };

  if (current?.columnId && current.status === status) {
    const still = await db.boardColumn.findFirst({
      where: { id: current.columnId, scope, kind: status },
      select: { id: true },
    });
    if (still) return { ok: true, columnId: still.id, status };
  }
  return { ok: true, columnId: await firstColumnOf(db, scope, status), status };
}
