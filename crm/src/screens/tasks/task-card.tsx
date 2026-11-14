import { CheckCheck, ListChecks, Paperclip } from "lucide-react";
import { useState } from "react";
import { columnOf, useColumns, type BoardColumnDef } from "@/api/columns";
import {
  TASK_PRIORITIES,
  TASK_STATUS_LABELS,
  type SubtaskProgress,
  type Task,
} from "@/api/tasks";
import { NoteHint } from "@/components/note-hint";
import { PersonChips } from "@/components/person-chip";
import { PriorityMark } from "@/components/priority-mark";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/cn";
import { describeDeadline, formatDate } from "@/lib/dates";

export function isClosed(task: Pick<Task, "status">): boolean {
  return task.status === "done" || task.status === "cancelled";
}

/** Раньше срок, потом важнее: две задачи на один день различает важность. */
export function byUrgency(left: Task, right: Task): number {
  const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Infinity;
  const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Infinity;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return (
    TASK_PRIORITIES.indexOf(right.priority) - TASK_PRIORITIES.indexOf(left.priority) ||
    left.position - right.position
  );
}

/**
 * Метка колонки на карточке и в строке. Видна, только когда что-то добавляет: первая
 * колонка «ждёт» — обычное состояние, закрытую видно по зачёркиванию. Подпись — название
 * колонки, которое дал админ; пока колонки не загрузились, по статусу.
 */
export function statusBadge(
  task: Task,
  columns: BoardColumnDef[] | null,
): { label: string; tone: "accent" | "neutral" } | null {
  if (isClosed(task)) return null;
  const column = columns ? columnOf(columns, task) : null;
  if (!column) {
    return task.status === "in_progress"
      ? { label: TASK_STATUS_LABELS.in_progress, tone: "accent" }
      : null;
  }
  if (column.id === columns?.find((item) => item.kind === "todo")?.id) return null;
  return {
    label: column.title,
    tone: column.kind === "in_progress" ? "accent" : "neutral",
  };
}

/** «2/5» на карточке и в строке. Без подзадач пусто: нулевой прогресс ничего не говорит. */
export function SubtaskCount({ subtasks }: { subtasks: SubtaskProgress }) {
  if (subtasks.total === 0) return null;

  return (
    <span
      title={`Подзадачи: ${subtasks.done} из ${subtasks.total}`}
      className="text-muted-foreground flex shrink-0 items-center gap-1 text-[13px] font-semibold tabular-nums"
    >
      <ListChecks size={15} strokeWidth={2.25} />
      {subtasks.done}/{subtasks.total}
    </span>
  );
}

/**
 * Сколько файлов у задачи. Скриншоты приходят из телеграма, и без этой метки о них не
 * узнать, не открыв задачу. `compact` — для строки списка, где места на слово нет.
 */
export function FileCount({
  count,
  compact = false,
}: {
  count: number;
  compact?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <span
      title={`Файлов: ${count}`}
      className="text-muted-foreground flex shrink-0 items-center gap-1 text-[13px] font-semibold tabular-nums"
    >
      <Paperclip size={14} strokeWidth={2.25} />
      {compact ? count : `Файлов: ${count}`}
    </span>
  );
}

/**
 * «Проверено» у даты на сделанной задаче: админ принял работу, и задача уходит в архив
 * одним нажатием, не открывая окна. Это тот же ручной архив, что кнопка «В архив» в окне
 * и «☑️ Проверено» в телеграме.
 */
export function CheckedButton({ onChecked }: { onChecked: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title="Работа принята — убрать задачу в архив"
      onClick={(event) => {
        // Нажатие не должно открыть саму задачу.
        event.stopPropagation();
        setBusy(true);
        void onChecked().finally(() => setBusy(false));
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className="bg-accent-soft hover:bg-accent text-foreground inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-semibold transition disabled:opacity-50"
    >
      <CheckCheck size={13} strokeWidth={2.5} />
      Проверено
    </button>
  );
}

/** Показывать ли «Проверено»: сделана, ещё не в архиве, и проверять есть кому. */
export function canCheck(task: Task, onChecked: unknown): boolean {
  return Boolean(onChecked) && task.status === "done" && !task.archived && !task.parentId;
}

/**
 * Карточка задачи на доске: название, проект, срок и люди. Остальное — внутри.
 *
 * `showStatus` — для доски по проектам: проект там уже в заголовке колонки, и вместо его
 * строки полезнее видеть то, что на этой доске больше нигде не написано.
 */
export function TaskCard({
  task,
  onOpen,
  onChecked,
  showStatus = false,
}: {
  task: Task;
  onOpen: () => void;
  /** Есть только у админа: архив — его решение. */
  onChecked?: () => Promise<void>;
  showStatus?: boolean;
}) {
  const done = isClosed(task);
  const deadline = task.dueAt && !done ? describeDeadline(task.dueAt) : null;
  const closedOn = done && task.completedAt ? formatDate(task.completedAt) : null;
  const columns = useColumns("task");
  const badge = showStatus ? statusBadge(task, columns) : null;
  const files = task.files ?? 0;
  const top = Boolean(badge) || (!showStatus && Boolean(task.project)) || files > 0;
  const checkable = canCheck(task, onChecked);
  const hasFooter =
    deadline ||
    closedOn ||
    checkable ||
    task.developers.length > 0 ||
    task.subtasks.total > 0;

  return (
    // Не <button>: внутри бывает своя кнопка «Проверено», а кнопка в кнопке — ошибка
    // разметки, и браузер разрывает такую карточку.
    <div
      role="button"
      tabIndex={0}
      // Из «Сегодня» приходят посмотреть, где задача стоит, а открывается теперь доска.
      data-card-id={task.id}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer flex-col gap-2 p-4 text-left"
    >
      {/* Сверху: слева статус или проект, справа число файлов. */}
      {top && (
        <span className="flex min-w-0 items-center gap-2">
          {badge && (
            <Badge tone={badge.tone} className="text-[13px]">
              {badge.label}
            </Badge>
          )}
          {!showStatus && task.project && (
            <span className="text-muted-foreground min-w-0 truncate text-[13px] font-medium">
              {task.project.title}
            </span>
          )}
          <span className="ml-auto">
            <FileCount count={files} />
          </span>
        </span>
      )}

      {/* Заголовок не обрезается: на доске карточка — единственное место, где
          видно, что за задача, и «Сверстать главную стр…» здесь бесполезно. */}
      <span
        className={cn(
          "text-[15px] leading-snug font-semibold",
          done && "text-muted-foreground line-through",
        )}
      >
        {!done && (
          <PriorityMark
            priority={task.priority}
            size={14}
            className="mr-1 inline align-[-1px]"
          />
        )}
        {task.title}
      </span>

      <NoteHint note={task.note} className="mt-0 text-[13px]" />

      {hasFooter && (
        <span className="mt-1 flex min-h-6 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2.5">
            {deadline ? (
              <Badge tone={deadline.tone} className="text-[13px]">
                {deadline.label}
              </Badge>
            ) : (
              closedOn && (
                <span className="text-muted-foreground text-[13px]">{closedOn}</span>
              )
            )}
            {checkable && <CheckedButton onChecked={onChecked!} />}
            <SubtaskCount subtasks={task.subtasks} />
          </span>
          <PersonChips names={task.developers} />
        </span>
      )}
    </div>
  );
}
