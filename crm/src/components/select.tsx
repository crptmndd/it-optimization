import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { panelClass, useDropdown } from "./dropdown";

/**
 * Выпадающий список в стиле остального интерфейса.
 *
 * Родной `<select>` рисует список средствами системы: он не подчиняется ни
 * шрифтам, ни цветам, ни скруглениям — и посреди аккуратной формы выглядит
 * чужим. Оформить его нельзя, можно только заменить.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className,
  ariaLabel,
  icon,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  /** Значок слева от подписи — им список отличают от поля ввода на панели. */
  icon?: ReactNode;
}) {
  const {
    open,
    setOpen,
    present,
    box,
    trigger,
    panel: list,
  } = useDropdown<HTMLButtonElement>();
  const [active, setActive] = useState(0);

  const selected = options.find((option) => option.value === value);

  // Выбранный стрелками пункт подтягивается в видимую часть: иначе на длинном
  // списке подсветка уезжает за край и кажется, что клавиши не работают.
  useEffect(() => {
    if (!open) return;
    const option = list.current?.children[active];
    if (option instanceof HTMLElement) option.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  }

  // Все клавиши обрабатываются на кнопке: фокус никуда не уходит, поэтому
  // список остаётся чисто визуальным и не спорит с формой за фокус.
  function onKeyDown(event: React.KeyboardEvent) {
    if (disabled) return;

    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setActive(
          Math.max(
            0,
            options.findIndex((option) => option.value === value),
          ),
        );
        setOpen(true);
      }
      return;
    }

    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(options.length - 1, current + 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    }
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.value === value),
            ),
          );
          setOpen((current) => !current);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "bg-field focus-visible:ring-accent disabled:bg-disabled disabled:text-muted-foreground flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium transition outline-none focus-visible:ring-2",
          className,
        )}
      >
        {icon && (
          <span className="text-muted-foreground shrink-0" aria-hidden="true">
            {icon}
          </span>
        )}
        <span
          className={cn("min-w-0 flex-1 truncate", !selected && "text-muted-foreground")}
        >
          {selected?.label ?? "—"}
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
            ref={list}
            role="listbox"
            style={{
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              width: box.width,
              maxHeight: Math.min(256, box.maxHeight),
            }}
            className={cn(
              panelClass,
              "p-1.5",
              open ? "crm-pop-in" : "crm-pop-out pointer-events-none",
            )}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
                className={cn(
                  "flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition",
                  index === active && "bg-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === value && (
                  <Check size={15} strokeWidth={2.75} className="shrink-0" />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
