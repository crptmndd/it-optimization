import { Plus } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
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

/** Отступ под доской, он же место для горизонтальной полосы прокрутки: `pb-2` ниже. */
const BOARD_PADDING_BOTTOM = 8;

/** Низкое окно: колонка всё ещё должна оставаться колонкой, а не полоской. */
const MIN_COLUMN_HEIGHT = 320;

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
  reorderable = true,
  readOnly = false,
}: {
  columns: BoardColumn<T>[];
  renderCard: (item: T) => ReactNode;
  /**
   * Куда и в каком порядке. `ids` — весь новый состав колонки: частичные
   * операции над множеством дают гонки, когда двое двигают карточки разом.
   * Не нужен только при `readOnly`.
   */
  onMove?: (columnKey: string, ids: string[]) => void;
  /** Завести запись сразу в этой колонке — иначе статус пришлось бы менять после. */
  onAdd?: (columnKey: string) => void;
  /**
   * false — порядка внутри колонки нет: карточки в ней упорядочены сами, по срочности.
   * Перенос в другую колонку работает, перенос внутри ничего не делает, и черта вставки
   * не рисуется, чтобы не обещать место, которого не будет.
   */
  reorderable?: boolean;
  /** Только смотреть: карточки не таскаются, а «+» в колонках нет. */
  readOnly?: boolean;
}) {
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Карточка, перед которой встанет перетаскиваемая. null — в конец колонки. */
  const [beforeId, setBeforeId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [columnHeight, setColumnHeight] = useState<number>();

  /*
   * Колонка до низа окна: бросить карточку можно в любом её месте, а не только
   * прицелившись в короткий столбик из пары карточек. Остаток измеряется, а не вычитается
   * константой: шапка у экранов своя, и фильтры на узком окне переносятся на вторую
   * строку. Следим за `main`, потому что его ширина меняется и без `resize` окна, когда
   * сворачивают боковую панель. После `animationend` меряем ещё раз: экран въезжает со
   * сдвигом, и замер на лету навсегда укоротил бы колонку на его остаток.
   */
  useLayoutEffect(() => {
    const board = root.current;
    const main = board?.closest("main");
    if (!board || !main) return;

    function fit() {
      if (!board || !main) return;
      const top =
        board.getBoundingClientRect().top -
        main.getBoundingClientRect().top +
        main.scrollTop;
      const free =
        main.clientHeight -
        top -
        parseFloat(getComputedStyle(main).paddingBottom) -
        BOARD_PADDING_BOTTOM;
      setColumnHeight(Math.max(MIN_COLUMN_HEIGHT, Math.floor(free)));
    }

    const observer = new ResizeObserver(fit);
    observer.observe(main);
    main.addEventListener("animationend", fit);
    return () => {
      observer.disconnect();
      main.removeEventListener("animationend", fit);
    };
  }, []);

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
    // Без порядка карточке считать нечего: событие всплывает к колонке.
    if (!reorderable || !dragging || dragging.id === itemId) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    if (!after) {
      setBeforeId(itemId);
      return;
    }
    const index = items.findIndex((item) => item.id === itemId);
    setBeforeId(items[index + 1]?.id ?? null);
  }

  /**
   * Ниже последней карточки — значит, в конец. Колонка тянется до низа окна, и бросают
   * чаще всего как раз в пустоту под карточками: без этого сработало бы последнее место
   * вставки, через которое пролетел курсор. Просветы между карточками сюда не попадают,
   * иначе черта прыгала бы вниз на каждом из них.
   */
  function handleColumnDragOver(event: DragEvent, columnKey: string) {
    event.preventDefault();
    setOver(columnKey);

    const cards = event.currentTarget.querySelectorAll("[data-board-card]");
    const last = cards[cards.length - 1];
    if (last && event.clientY > last.getBoundingClientRect().bottom) setBeforeId(null);
  }

  /** `dragleave` приходит и при переходе между детьми колонки, это ещё не уход с неё. */
  function handleColumnDragLeave(event: DragEvent, columnKey: string) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOver((current) => (current === columnKey ? null : current));
    setBeforeId(null);
  }

  function handleDrop(event: DragEvent, columnKey: string) {
    event.preventDefault();
    const current = dragging;
    const target = columns.find((column) => column.key === columnKey);
    const insertBefore = beforeId;
    reset();
    if (!current || !target) return;
    if (!reorderable && current.from === columnKey) return;

    const ids = target.items.map((item) => item.id).filter((id) => id !== current.id);
    const at = insertBefore ? ids.indexOf(insertBefore) : -1;
    if (at === -1) ids.push(current.id);
    else ids.splice(at, 0, current.id);

    onMove?.(columnKey, ids);
  }

  return (
    // Поля экрана отрицательные: прокрутка доходит до края окна, а не обрывается на
    // отступе, и обрезанная колонка сама подсказывает, что доска едет вбок. Прокручивается
    // только она: шапка и фильтры остаются на месте.
    <div
      ref={root}
      className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-5 sm:px-5 md:-mx-8 md:px-8"
    >
      {/* Если колонки влезают, они делят ширину поровну: потолка нет, на большом
          мониторе доска занимает экран, а не жмётся к левому краю. Не влезают — держат
          читаемую ширину, а доска прокручивается. Минимальная ширина сетки равна сумме
          колонок: иначе колонки вылезали бы за неё, и правое поле обёртки пропадало. */}
      <div
        className="grid [grid-template-columns:repeat(var(--cols),minmax(16.5rem,1fr))] gap-3"
        style={
          {
            "--cols": columns.length,
            minWidth: `calc(${columns.length} * 16.5rem + ${columns.length - 1} * 0.75rem)`,
          } as CSSProperties
        }
      >
        {columns.map((column) => {
          const active = over === column.key && dragging?.from !== column.key;

          return (
            <div
              key={column.key}
              {...(!readOnly && {
                onDragOver: (event: DragEvent) => handleColumnDragOver(event, column.key),
                onDragLeave: (event: DragEvent) =>
                  handleColumnDragLeave(event, column.key),
                onDrop: (event: DragEvent) => handleDrop(event, column.key),
              })}
              style={{ minHeight: columnHeight }}
              className={cn(
                // В тёмной теме колонка почти не светлее полотна: иначе карточки сливаются с ней.
                "bg-ink/[0.035] dark:bg-ink/[0.02] flex min-w-0 flex-col rounded-2xl p-2 transition-colors",
                active && "bg-accent-soft dark:bg-accent-soft",
              )}
            >
              <div className="flex min-h-9 items-center gap-2 px-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    DOT[column.tone ?? "neutral"],
                  )}
                />
                {/* Две строки вместо обрезки: на доске по проектам название колонки — это
                    единственное место, где читается проект. */}
                <span
                  title={column.label}
                  className="line-clamp-2 text-sm font-bold break-words"
                >
                  {column.label}
                </span>
                <span className="text-muted-foreground text-[13px] font-semibold">
                  {column.items.length}
                </span>
                {onAdd && !readOnly && (
                  <button
                    type="button"
                    onClick={() => onAdd(column.key)}
                    aria-label={`Добавить в «${column.label}»`}
                    className="text-muted-foreground hover:bg-background hover:text-foreground ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg transition"
                  >
                    <Plus size={15} strokeWidth={2.5} />
                  </button>
                )}
              </div>

              <div className="mt-1 flex flex-col gap-2.5">
                {column.items.map((item) => (
                  <div
                    key={item.id}
                    data-board-card
                    draggable={!readOnly}
                    onDragStart={() => setDragging({ id: item.id, from: column.key })}
                    onDragEnd={reset}
                    onDragOver={(event) =>
                      handleCardDragOver(event, item.id, column.items)
                    }
                    className={cn(
                      "relative rounded-xl transition",
                      !readOnly && "cursor-grab active:cursor-grabbing",
                      dragging?.id === item.id && "opacity-30",
                      // Черта сверху показывает, куда именно встанет карточка. Она снаружи
                      // скругления, поэтому обрезка у внутреннего слоя, а не здесь.
                      reorderable &&
                        dragging &&
                        beforeId === item.id &&
                        "before:bg-accent before:absolute before:-top-1.5 before:right-0 before:left-0 before:h-0.5 before:rounded-full",
                    )}
                  >
                    {/* Фон задаёт сама карточка: цвет несёт смысл, и у задач с проектами
                        он разный — доска в него не лезет. */}
                    <div className="bg-background shadow-card overflow-hidden rounded-xl transition hover:shadow-md">
                      {renderCard(item)}
                    </div>
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
    </div>
  );
}
