import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { panelClass, useDropdown } from "./dropdown";

/**
 * Выбор даты. Значение — та же строка `ГГГГ-ММ-ДД`, что у `<input type="date">`,
 * поэтому поле меняется местами с системным без правок вокруг.
 *
 * Системное поле заменено потому, что «дд.мм.гггг» со значком браузера посреди формы
 * выглядит чужим и на каждом устройстве по-своему, а чаще всего нужно одно нажатие:
 * сегодня, завтра, через неделю.
 *
 * Дата собирается из частей в локальном времени: `new Date("2026-11-02")` разобрался
 * бы как UTC и в поясе с отрицательным смещением стал бы вчерашним днём.
 */

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;
const monthTitle = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  weekday: "short",
});
const shortDateYear = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function toValue(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromValue(value: string): Date | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function plusDays(days: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
}

/** «05.11.2026» для поля ввода. */
function toTyped(value: string): string {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}.${month}.${year}` : "";
}

/**
 * Разбор набранной даты: «5.11.2026», «05.11.26» и «5.11» (текущий год). Несуществующий
 * день вроде 31.02 даёт `null`: `Date` молча перенёс бы его на март.
 */
function fromTyped(text: string): string | null {
  const parts = text
    .trim()
    .split(/[./\-\s]+/)
    .map(Number);
  const [day, month, rawYear] = parts;
  if (!day || !month || parts.length > 3) return null;

  const year =
    rawYear === undefined
      ? new Date().getFullYear()
      : rawYear < 100
        ? 2000 + rawYear
        : rawYear;

  const date = new Date(year, month - 1, day);
  const real = date.getMonth() === month - 1 && date.getDate() === day;
  return real ? toValue(date) : null;
}

function caption(value: string): string {
  const date = fromValue(value);
  if (!date) return "";
  if (value === toValue(plusDays(0))) return "Сегодня";
  if (value === toValue(plusDays(1))) return "Завтра";
  if (date.getFullYear() !== new Date().getFullYear()) return shortDateYear.format(date);
  return shortDate.format(date);
}

/** Неделя начинается с понедельника, поэтому недостающие дни берутся с запасом. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const shift = (first.getDay() + 6) % 7;
  return Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), index - shift + 1),
  );
}

export function DateField({
  value,
  onChange,
  placeholder = "Не указана",
  ariaLabel,
  clearLabel = "Убрать дату",
  quick = false,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  clearLabel?: string;
  /** Кнопки «Сегодня / Завтра / Через неделю»: для сроков, а не для дат договора. */
  quick?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { open, setOpen, present, box, trigger, panel } = useDropdown<HTMLButtonElement>({
    panelWidth: 304,
    panelHeight: 380,
  });
  const picked = fromValue(value);
  const [month, setMonth] = useState(() => picked ?? new Date());
  const [typed, setTyped] = useState("");
  const [invalid, setInvalid] = useState(false);
  const typedInput = useRef<HTMLInputElement>(null);
  /** С клавиатуры фокус уходит в поле ввода, а с мыши нет: на телефоне вылезла бы клавиатура. */
  const byKeyboard = useRef(false);

  useEffect(() => {
    if (!open) return;
    setMonth(fromValue(value) ?? new Date());
    setTyped(toTyped(value));
    setInvalid(false);
  }, [open, value]);

  // Панель рисуется порталом в конце страницы, и обычный Tab дошёл бы до неё нескоро.
  useEffect(() => {
    if (open && box && byKeyboard.current) typedInput.current?.focus();
  }, [open, box]);

  const days = useMemo(() => monthGrid(month), [month]);

  function onTriggerKey(event: KeyboardEvent) {
    if (open) {
      if (event.key === "Tab") setOpen(false);
      return;
    }
    if (["Enter", " ", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      byKeyboard.current = true;
      setOpen(true);
    }
  }

  function onTypedKey(event: KeyboardEvent) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key !== "Enter") return;
    // Не отправлять форму вокруг: Enter здесь значит «взять эту дату».
    event.preventDefault();
    event.stopPropagation();
    const next = fromTyped(typed);
    if (next) choose(next);
    else setInvalid(true);
  }
  const today = toValue(plusDays(0));

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          byKeyboard.current = false;
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKey}
        className={cn(
          "bg-field focus-visible:ring-accent disabled:bg-disabled disabled:text-muted-foreground flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium transition outline-none focus-visible:ring-2",
          className,
        )}
      >
        <CalendarDays
          size={15}
          strokeWidth={2.25}
          className="text-muted-foreground shrink-0"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            !value && "text-muted-foreground font-normal",
          )}
        >
          {value ? caption(value) : placeholder}
        </span>
        <ChevronDown
          size={15}
          strokeWidth={2}
          className={cn(
            "text-muted-foreground shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {present &&
        box &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={ariaLabel ?? "Выбор даты"}
            style={{
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              width: box.width,
              maxHeight: box.maxHeight,
            }}
            className={cn(
              panelClass,
              "p-3",
              open ? "crm-pop-in" : "crm-pop-out pointer-events-none",
            )}
          >
            <input
              ref={typedInput}
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={onTypedKey}
              inputMode="numeric"
              placeholder="дд.мм.гггг"
              aria-label="Дата цифрами"
              aria-invalid={invalid}
              className={cn(
                "bg-field placeholder:text-muted-foreground focus:ring-accent mb-3 h-9 w-full rounded-lg px-3 text-sm font-medium outline-none placeholder:font-normal focus:ring-2",
                invalid && "ring-danger focus:ring-danger ring-2",
              )}
            />

            {quick && (
              <div className="mb-3 grid grid-cols-3 gap-1.5">
                {[
                  { label: "Сегодня", days: 0 },
                  { label: "Завтра", days: 1 },
                  { label: "Через неделю", days: 7 },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => choose(toValue(plusDays(item.days)))}
                    className="bg-field hover:bg-disabled h-9 rounded-lg px-1 text-xs font-semibold transition"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                aria-label="Предыдущий месяц"
                onClick={() =>
                  setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
                }
                className="hover:bg-muted flex size-8 items-center justify-center rounded-lg transition"
              >
                <ChevronLeft size={16} strokeWidth={2.5} />
              </button>
              <span className="text-sm font-bold capitalize">
                {monthTitle.format(month).replace(" г.", "")}
              </span>
              <button
                type="button"
                aria-label="Следующий месяц"
                onClick={() =>
                  setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
                }
                className="hover:bg-muted flex size-8 items-center justify-center rounded-lg transition"
              >
                <ChevronRight size={16} strokeWidth={2.5} />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-y-0.5 text-center">
              {WEEKDAYS.map((day) => (
                <span
                  key={day}
                  className="text-muted-foreground py-1 text-[11px] font-semibold"
                >
                  {day}
                </span>
              ))}
              {days.map((day) => {
                const key = toValue(day);
                const outside = day.getMonth() !== month.getMonth();
                return (
                  <button
                    key={key}
                    type="button"
                    aria-label={shortDateYear.format(day)}
                    aria-pressed={key === value}
                    onClick={() => choose(key)}
                    className={cn(
                      "mx-auto flex size-9 items-center justify-center rounded-lg text-[13px] font-semibold transition",
                      key === value
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted",
                      key !== value && outside && "text-muted-foreground/50",
                      key === today && key !== value && "ring-foreground/25 ring-1",
                    )}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>

            {value && (
              <button
                type="button"
                onClick={() => choose("")}
                className="text-muted-foreground hover:bg-muted hover:text-foreground mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition"
              >
                <X size={14} strokeWidth={2.5} />
                {clearLabel}
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
