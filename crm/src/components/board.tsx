import { Plus } from "lucide-react";
import { useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Доска с колонками и перетаскиванием.
 *
 * На HTML5 drag-and-drop, без библиотеки: карточек десятки, а не тысячи, и
 * @dnd-kit с его сенсорами и разрешением коллизий стоил бы 40 КБ ради того,
 * что браузер умеет сам. Плата честная — перетаскивание не работает на
 * телефоне, поэтому статус там меняется через карточку, а список остаётся
 * полноценным способом работы.
 */

/** Цвет колонки — смыслом, а не для красоты: он же читается на карточках. */
export type ColumnTone = "neutral" | "accent" | "warning" | "success" | "danger";

const DOT: Record<ColumnTone, string> = {
  neutral: "bg-muted-foreground/40",
  accent: "bg-accent",
  warning: "bg-warning",
  success: "bg-success",
  danger: "bg-danger",
};

export interface BoardColumn<T> {
  key: string;
  label: string;
  items: T[];
  tone?: ColumnTone;
}

export function Board<T extends { id: string }>({
  columns,
  renderCard,
  onMove,
  onAdd,
}: {
  columns: BoardColumn<T>[];
  renderCard: (item: T) => ReactNode;
  /**
   * Куда и в каком порядке. `ids` — весь новый состав колонки: частичные
   * операции над множеством дают гонки, когда двое двигают карточки разом.
   */
  onMove: (columnKey: string, ids: string[]) => void;
  /** Завести запись сразу в этой колонке — иначе статус пришлось бы менять после. */
  onAdd?: (columnKey: string) => void;
}) {
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Карточка, перед которой встанет перетаскиваемая. null — в конец колонки. */
  const [beforeId, setBeforeId] = useState<string | null>(null);

  function reset() {
    setDragging(null);
    setOver(null);
    setBeforeId(null);
  }

  /**
   * Куда попадёт карточка: выше середины наведённой — перед ней, ниже — после.
   * Считаем по геометрии, а не по индексу, иначе при разной высоте карточек
   * место вставки не совпадает с тем, что видит человек.
   */
  function handleCardDragOver(event: DragEvent, itemId: string, items: T[]) {
    if (!dragging || dragging.id === itemId) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    if (!after) {
      setBeforeId(itemId);
      return;
    }
    const index = items.findIndex((item) => item.id === itemId);
    setBeforeId(items[index + 1]?.id ?? null);
  }

  function handleDrop(event: DragEvent, columnKey: string) {
    event.preventDefault();
    const current = dragging;
    const target = columns.find((column) => column.key === columnKey);
    const insertBefore = beforeId;
    reset();
    if (!current || !target) return;

    const ids = target.items.map((item) => item.id).filter((id) => id !== current.id);
    const at = insertBefore ? ids.indexOf(insertBefore) : -1;
    if (at === -1) ids.push(current.id);
    else ids.splice(at, 0, current.id);

    onMove(columnKey, ids);
  }

  return (
    // Колонки влезают целиком: горизонтальная прокрутка на доске означает, что
    // часть работы не видна, а ради неё доску и открывают. Ширина ограничена
    // сверху — на широком мониторе растянутая на 400 пикселей карточка с одной
    // строкой текста выглядит пустой. До `lg` — по две в ряд: на планшете рядом
    // с боковым меню пять колонок сжимались до нечитаемых.
    <div
      className="grid [grid-template-columns:repeat(2,minmax(0,1fr))] justify-start gap-3 lg:[grid-template-columns:repeat(var(--cols),minmax(0,19rem))]"
      style={{ "--cols": columns.length } as CSSProperties}
    >
      {columns.map((column) => {
        const active = over === column.key && dragging?.from !== column.key;

        return (
          <div
            key={column.key}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(column.key);
            }}
            onDragLeave={() => {
              setOver((current) => (current === column.key ? null : current));
              setBeforeId(null);
            }}
            onDrop={(event) => handleDrop(event, column.key)}
            className={cn(
              "flex min-w-0 flex-col rounded-2xl bg-black/[0.035] p-2 transition-colors",
              active && "bg-accent-soft",
            )}
          >
            <div className="flex h-9 items-center gap-2 px-2">
              <span
                className={cn("size-2 rounded-full", DOT[column.tone ?? "neutral"])}
              />
              <span className="text-sm font-bold">{column.label}</span>
              <span className="text-muted-foreground text-[13px] font-semibold">
                {column.items.length}
              </span>
              {onAdd && (
                <button
                  type="button"
                  onClick={() => onAdd(column.key)}
                  aria-label={`Добавить в «${column.label}»`}
                  className="text-muted-foreground hover:bg-background hover:text-foreground ml-auto flex size-7 items-center justify-center rounded-lg transition"
                >
                  <Plus size={15} strokeWidth={2.5} />
                </button>
              )}
            </div>

            <div className="mt-1 flex flex-col gap-2">
              {column.items.map((item) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => setDragging({ id: item.id, from: column.key })}
                  onDragEnd={reset}
                  onDragOver={(event) => handleCardDragOver(event, item.id, column.items)}
                  className={cn(
                    // Фон задаёт сама карточка: цвет несёт смысл, и у задач с
                    // проектами он разный — доска в него не лезет.
                    "bg-background shadow-card cursor-grab overflow-hidden rounded-xl transition active:cursor-grabbing",
                    "hover:shadow-md",
                    dragging?.id === item.id && "opacity-30",
                    // Черта сверху показывает, куда именно встанет карточка.
                    dragging &&
                      beforeId === item.id &&
                      "before:bg-accent relative before:absolute before:-top-1.5 before:right-0 before:left-0 before:h-0.5 before:rounded-full",
                  )}
                >
                  {renderCard(item)}
                </div>
              ))}

              {/* Место под карточку: без него при перетаскивании в пустую
                  колонку непонятно, попадёт ли она туда вообще. */}
              {active && column.items.length === 0 && (
                <div className="border-accent-border text-muted-foreground rounded-xl border-2 border-dashed px-3 py-7 text-center text-xs">
                  Отпустите здесь
                </div>
              )}

              {column.items.length === 0 && !active && (
                <p className="text-muted-foreground px-2 py-3 text-[13px]">Пусто</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
