import type { Task } from "@/api/tasks";
import { Board, type BoardColumn } from "@/components/board";
import { EmptyState } from "@/components/ui";
import { byUrgency, isClosed, TaskCard } from "./task-card";

/** Ключ колонки без проекта. Настоящие ключи — uuid, совпасть с ним они не могут. */
const NO_PROJECT = "none";

/**
 * Колонки — проекты, где есть открытые задачи: больше задач левее, задачи без проекта
 * всегда в конце. Статус проекта не важен: открытая задача закрытого проекта всё ещё
 * работа, и пропасть с доски она не должна. При равном числе порядок решает название,
 * иначе соседние колонки менялись бы местами от запроса к запросу.
 */
function projectColumns(tasks: Task[]): BoardColumn<Task>[] {
  const byProject = new Map<string, BoardColumn<Task>>();
  const noProject: Task[] = [];

  for (const task of tasks) {
    if (isClosed(task)) continue;

    if (!task.project) {
      noProject.push(task);
      continue;
    }

    const column = byProject.get(task.project.id);
    if (column) column.items.push(task);
    else {
      byProject.set(task.project.id, {
        key: task.project.id,
        label: task.project.title,
        tone: "accent",
        items: [task],
      });
    }
  }

  const columns = [...byProject.values()].sort(
    (left, right) =>
      right.items.length - left.items.length ||
      left.label.localeCompare(right.label, "ru"),
  );
  if (noProject.length > 0) {
    columns.push({ key: NO_PROJECT, label: "Без проекта", items: noProject });
  }

  for (const column of columns) column.items.sort(byUrgency);
  return columns;
}

/**
 * Доска задач по проектам. Показывает только открытое: колонка проекта не архив.
 *
 * Порядка внутри колонки нет, карточки стоят по срочности, поэтому перенос значит одно:
 * задача сменила проект. Колонка есть только там, где есть задачи, так что опустевший
 * проект исчезает с доски, а привязать задачу к проекту без задач можно в её карточке.
 */
export function ProjectBoard({
  tasks,
  onMove,
  onAdd,
  onOpen,
}: {
  tasks: Task[];
  onMove: (task: Task, project: Task["project"]) => void;
  /** `null` — колонка «Без проекта». */
  onAdd: (projectId: string | null) => void;
  onOpen: (task: Task) => void;
}) {
  const columns = projectColumns(tasks);

  if (columns.length === 0) {
    return (
      <EmptyState
        title="Открытых задач нет"
        note="Здесь только открытые, закрытые ищите в списке."
      />
    );
  }

  function handleMove(columnKey: string, ids: string[]) {
    const target = columnKey === NO_PROJECT ? null : columnKey;
    const moved = tasks.find(
      (task) => ids.includes(task.id) && (task.project?.id ?? null) !== target,
    );
    if (!moved) return;

    // Название берём у соседей по колонке: в списке открытых проекта может не оказаться.
    const project = tasks.find((task) => task.project?.id === target)?.project ?? null;
    onMove(moved, project);
  }

  return (
    <Board
      reorderable={false}
      columns={columns}
      onAdd={(columnKey) => onAdd(columnKey === NO_PROJECT ? null : columnKey)}
      onMove={handleMove}
      renderCard={(task) => (
        <TaskCard task={task} showStatus onOpen={() => onOpen(task)} />
      )}
    />
  );
}
