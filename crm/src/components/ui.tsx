import { Search, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/*
 * Мелкие примитивы одним файлом. Отдельная папка на каждую кнопку окупается
 * в дизайн-системе; здесь их десяток, и в одном файле их видно целиком.
 */

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * Лаймовая одна на экран: главное действие. Всё остальное, что повторяется в
   * строках списка, — `secondary`, иначе двадцать ярких кнопок спорят за внимание.
   */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
}) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100",
        size === "md" ? "h-10 px-4 text-sm" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-accent text-accent-foreground hover:bg-accent-hover",
        variant === "secondary" && "bg-field text-foreground hover:bg-disabled",
        variant === "ghost" &&
          "text-muted-foreground hover:bg-muted hover:text-foreground",
        variant === "danger" && "text-danger hover:bg-danger-soft",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
        {label}
      </span>
      {children}
      {hint && <span className="text-muted-foreground mt-1.5 block text-xs">{hint}</span>}
    </label>
  );
}

// Недоступное поле заметно темнее: без этого оно отличается от рабочего только
// тем, что не принимает ввод, — и человек сначала пробует печатать, а потом ищет
// причину. Поле залито, а не обведено: на белой карточке рамки вокруг каждого
// контрола дают сетку линий вместо формы.
const controlClass =
  "w-full rounded-lg bg-field px-3 text-sm font-medium outline-none transition placeholder:font-normal placeholder:text-muted-foreground focus:ring-2 focus:ring-accent disabled:bg-disabled disabled:text-muted-foreground";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(controlClass, "h-10", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(controlClass, "resize-y py-2.5", props.className)}
    />
  );
}

// Родной <select> заменён своим: системный список не подчиняется ни шрифтам,
// ни цветам и посреди формы выглядит чужим. Реэкспорт — чтобы места вызова не
// меняли строку импорта.
export { Select, type SelectOption } from "./select";

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "accent" | "danger" | "warning" | "success";
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-lg px-2 text-xs font-semibold whitespace-nowrap",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "accent" && "bg-accent-soft text-foreground",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "success" && "bg-success-soft text-success",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Белая карточка на сером полотне: основной строительный блок экранов. */
export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("bg-background shadow-card rounded-2xl", className)}>
      {children}
    </div>
  );
}

/**
 * Список строк в одной карточке, разделённых линией. Рамка вокруг каждой строки
 * давала дюжину рамок на экран; глаз читал их, а не содержимое.
 */
export function List({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      className={cn(
        "bg-background shadow-card divide-border divide-y overflow-hidden rounded-2xl",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** Шапка экрана: заголовок слева, главное действие справа. */
export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Главное действие экрана. */
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-[28px] sm:leading-9">
          {title}
        </h1>
        {subtitle && (
          <p className="text-muted-foreground mt-0.5 text-sm font-medium">{subtitle}</p>
        )}
      </div>
      {children}
    </header>
  );
}

/** Заголовок группы внутри экрана. */
export function SectionTitle({
  title,
  count,
  tone,
  hint,
  children,
}: {
  title: string;
  count?: number;
  /** `danger` — раздел, который нельзя пропустить глазами. */
  tone?: "danger";
  hint?: string;
  /** Справа: сумма, ссылка, маленькое действие. */
  children?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3 px-1">
      <div className="min-w-0 flex-1">
        <h2
          className={cn(
            "flex items-baseline gap-2 text-[17px] leading-6 font-bold tracking-tight",
            tone === "danger" && "text-danger",
          )}
        >
          {title}
          {count !== undefined && (
            <span className="text-muted-foreground text-sm font-semibold">{count}</span>
          )}
        </h2>
        {hint && <p className="text-muted-foreground mt-0.5 text-[13px]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export interface SegmentOption {
  value: string;
  label: string;
  /** Число рядом с подписью. */
  count?: number;
  /** Со значком подпись прячется: она идёт в подсказку и в aria-label. */
  icon?: LucideIcon;
}

/** Переключатель в одну линию: и разделы списка, и вид. Выбранное всегда на виду. */
export function Segmented({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SegmentOption[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "crm-no-scrollbar inline-flex h-10 max-w-full shrink-0 items-center gap-0.5 overflow-x-auto rounded-xl bg-black/[0.055] p-1",
        className,
      )}
    >
      {options.map((option) => {
        const picked = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={picked}
            aria-label={Icon ? option.label : undefined}
            title={Icon ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold whitespace-nowrap transition",
              Icon && "w-9 justify-center px-0",
              picked
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? <Icon size={16} strokeWidth={2.25} /> : option.label}
            {option.count !== undefined && option.count > 0 && (
              <span className="text-muted-foreground text-xs">{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Да или нет. Обычная галочка в ряду с большими полями теряется. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  icon: Icon,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="bg-field disabled:bg-disabled flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm font-medium transition"
    >
      {Icon && (
        <Icon
          size={15}
          strokeWidth={2.25}
          className={cn("shrink-0", checked ? "text-danger" : "text-muted-foreground")}
        />
      )}
      <span className="min-w-0 flex-1">
        {label}
        {hint && (
          <span className="text-muted-foreground block text-xs font-normal">{hint}</span>
        )}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-surface" : "bg-black/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full transition-[left]",
            checked ? "bg-accent left-[18px]" : "bg-background left-0.5",
          )}
        />
      </span>
    </button>
  );
}

/**
 * Поиск внутри раздела. На телефоне свёрнут в значок: ряд и так занят фильтрами, а
 * ищут здесь реже, чем смотрят.
 */
export function SearchField({
  value,
  onChange,
  placeholder = "Поиск",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const expanded = open || value !== "";

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={placeholder}
        className={cn(
          "bg-background shadow-card text-muted-foreground size-10 shrink-0 items-center justify-center rounded-xl sm:hidden",
          expanded ? "hidden" : "flex",
        )}
      >
        <Search size={17} strokeWidth={2.25} />
      </button>
      <div
        className={cn(
          "relative w-full sm:block sm:w-60",
          expanded ? "block" : "hidden",
          className,
        )}
      >
        <Search
          size={16}
          strokeWidth={2.25}
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
        />
        <input
          ref={input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setOpen(false)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="bg-background shadow-card placeholder:text-muted-foreground focus:ring-accent h-10 w-full rounded-xl pr-3 pl-9 text-sm font-medium transition outline-none placeholder:font-normal focus:ring-2"
        />
      </div>
    </>
  );
}

/** Столько идёт затухание окна — ровно длительность `.crm-fade-out` в стилях. */
const LEAVE_MS = 160;

export function Modal({
  title,
  badge,
  onClose,
  children,
  wide,
}: {
  title: string;
  /** Метка рядом с заголовком. Отдельно: `title` идёт ещё и в aria-label окна. */
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Шире обычного — для окон с несколькими списками рядом. */
  wide?: boolean;
}) {
  /*
   * Закрытие рисуется здесь, а не у вызывающего кода: тот убирает окно из
   * разметки сменой своего состояния, и без задержки узел исчезал бы в тот же
   * кадр — то есть анимации ухода не было бы вовсе. Поэтому все три способа
   * закрыть (крестик, Escape, нажатие мимо) идут через `leave`, а настоящий
   * `onClose` вызывается уже после затухания.
   */
  const [leaving, setLeaving] = useState(false);

  const leave = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onClose, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leaving, onClose]);

  // Escape закрывает окно: без этого единственный выход — мышью по крестику,
  // а форма открывается с клавиатуры десятки раз в день.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") leave();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [leave]);

  // В body, а не на месте: страница появляется с анимацией transform, и пока она идёт,
  // `fixed` считался бы от страницы. Окно, открытое сразу после перехода, стояло не там.
  return createPortal(
    <div
      data-modal-backdrop
      className={cn(
        "fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-6",
        leaving ? "crm-fade-out" : "crm-fade-in",
      )}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) leave();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "bg-background max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-3xl sm:p-6",
          wide ? "max-w-2xl" : "max-w-lg",
          leaving ? "crm-sink-out" : "crm-rise-in",
        )}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight">
            {title}
            {badge}
          </h2>
          <button
            type="button"
            onClick={leave}
            aria-label="Закрыть"
            className="text-muted-foreground bg-muted hover:bg-disabled hover:text-foreground -mt-0.5 -mr-0.5 flex size-8 shrink-0 items-center justify-center rounded-full transition"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="bg-danger-soft text-danger rounded-xl px-3.5 py-2.5 text-sm font-medium"
    >
      {children}
    </p>
  );
}

export function EmptyState({ title, note }: { title: string; note: string }) {
  return (
    <Card className="px-6 py-14 text-center">
      <p className="text-[15px] font-bold">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{note}</p>
    </Card>
  );
}

/** Заглушка на время загрузки: экран не прыгает, когда приходят настоящие строки. */
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Загружаем"
      className="bg-background shadow-card divide-border divide-y overflow-hidden rounded-2xl"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-4">
          <span className="bg-muted size-5 shrink-0 animate-pulse rounded-full" />
          <span
            className="bg-muted h-3.5 animate-pulse rounded-full"
            style={{ width: `${62 - index * 9}%` }}
          />
        </div>
      ))}
    </div>
  );
}
