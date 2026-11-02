import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Месячная сетка со сроками.
 *
 * Своя, а не библиотека: нужен один месяц с русской неделей от понедельника,
 * а FullCalendar весит больше всего остального приложения. Ячейки строятся
 * через локальный Date — все сроки и так живут в часовом поясе браузера.
 */

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

const monthTitle = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Ключ дня без времени — по нему события раскладываются по ячейкам. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function MonthCalendar<T>({
  items,
  dateOf,
  renderItem,
  onPickDay,
}: {
  items: T[];
  /** ISO-дата события или null — такие в сетку не попадают. */
  dateOf: (item: T) => string | null;
  renderItem: (item: T) => ReactNode;
  onPickDay?: (isoDate: string) => void;
}) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const cells = useMemo(() => {
    const first = startOfMonth(cursor);
    // getDay(): воскресенье = 0. Сдвигаем к понедельнику как началу недели.
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(first.getDate() - lead);

    // Шесть недель всегда: сетка не прыгает по высоте при смене месяца.
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [cursor]);

  const byDay = useMemo(() => {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const iso = dateOf(item);
      if (!iso) continue;
      const key = dayKey(new Date(iso));
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return map;
  }, [items, dateOf]);

  const todayKey = dayKey(new Date());
  const month = cursor.getMonth();

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCursor(new Date(cursor.getFullYear(), month - 1, 1))}
          aria-label="Предыдущий месяц"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-1.5 transition"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-[15px] font-bold first-letter:uppercase">
          {monthTitle.format(cursor)}
        </span>
        <button
          type="button"
          onClick={() => setCursor(new Date(cursor.getFullYear(), month + 1, 1))}
          aria-label="Следующий месяц"
          className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-1.5 transition"
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          onClick={() => setCursor(startOfMonth(new Date()))}
          className="text-muted-foreground hover:bg-muted hover:text-foreground ml-1 rounded-lg px-2.5 py-1 text-sm font-medium transition"
        >
          Сегодня
        </button>
      </div>

      <div className="bg-background shadow-card mt-3 grid grid-cols-7 overflow-hidden rounded-2xl">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="border-border text-muted-foreground border-b px-2 py-2 text-center text-xs font-semibold"
          >
            {day}
          </div>
        ))}

        {cells.map((date) => {
          const key = dayKey(date);
          const dayItems = byDay.get(key) ?? [];
          const outside = date.getMonth() !== month;

          return (
            <div
              key={key}
              onDoubleClick={() => onPickDay?.(key)}
              className={cn(
                "border-border min-h-24 border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0",
                outside && "bg-muted/50",
                key === todayKey && "bg-accent-muted",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-lg text-xs font-semibold",
                  outside ? "text-muted-foreground/60" : "text-muted-foreground",
                  key === todayKey && "bg-accent text-accent-foreground font-bold",
                )}
              >
                {date.getDate()}
              </span>
              <div className="mt-1 space-y-1">{dayItems.map(renderItem)}</div>
            </div>
          );
        })}
      </div>

      {onPickDay && (
        <p className="text-muted-foreground mt-2 text-xs">
          Двойной клик по дню — завести задачу на эту дату
        </p>
      )}
    </div>
  );
}
