import { ChevronDown, ChevronsUp, Flame, type LucideIcon } from "lucide-react";
import { TASK_PRIORITY_LABELS, type TaskPriority } from "@/api/tasks";
import { cn } from "@/lib/cn";

/** У обычной отметки нет: на большинстве задач значок не значил бы ничего. */
const MARKS: Partial<Record<TaskPriority, { icon: LucideIcon; tone: string }>> = {
  high: { icon: Flame, tone: "text-danger" },
  important: { icon: ChevronsUp, tone: "text-warning" },
  low: { icon: ChevronDown, tone: "text-muted-foreground" },
};

/**
 * Отметка важности рядом с названием задачи: одна на карточку, строку списка и «Сегодня».
 * Закрытым задачам её не показывают, это решает место вызова: на «Сегодня» их нет.
 */
export function PriorityMark({
  priority,
  size = 15,
  className,
}: {
  priority: TaskPriority;
  size?: number;
  className?: string;
}) {
  const mark = MARKS[priority];
  if (!mark) return null;
  const Icon = mark.icon;

  return (
    <Icon
      size={size}
      strokeWidth={2.5}
      role="img"
      aria-label={TASK_PRIORITY_LABELS[priority]}
      className={cn(mark.tone, className)}
    />
  );
}
