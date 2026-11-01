import { X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Мелкие примитивы одним файлом. Отдельная папка на каждую кнопку окупается
 * в дизайн-системе; здесь их пять, и в одном файле их видно целиком.
 */

export function Button({
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-50",
        variant === "primary" && "bg-surface text-surface-foreground hover:opacity-90",
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
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground mt-1 block text-xs">{hint}</span>}
    </label>
  );
}

// Недоступное поле заливается серым, а не остаётся белым: без этого оно
// отличается от рабочего только тем, что не принимает ввод, — и человек
// сначала пробует печатать, а потом ищет причину.
const controlClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition focus:border-accent disabled:bg-disabled disabled:text-muted-foreground";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(controlClass, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={cn(controlClass, "resize-y", props.className)} />
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
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
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

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6",
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
          "bg-background max-h-[90vh] w-full overflow-y-auto rounded-t-2xl p-5 shadow-xl sm:rounded-2xl",
          wide ? "max-w-xl" : "max-w-lg",
          leaving ? "crm-sink-out" : "crm-rise-in",
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold tracking-tight">
            {title}
            {badge}
          </h2>
          <button
            type="button"
            onClick={leave}
            aria-label="Закрыть"
            className="text-muted-foreground hover:bg-muted hover:text-foreground -m-1 rounded-lg p-1 transition"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="bg-danger-soft text-danger rounded-lg px-3 py-2.5 text-sm">
      {children}
    </p>
  );
}

export function EmptyState({ title, note }: { title: string; note: string }) {
  return (
    <div className="border-border rounded-xl border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{note}</p>
    </div>
  );
}
