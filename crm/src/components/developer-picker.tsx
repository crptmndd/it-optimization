import { Check, ChevronDown, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCurrentUser } from "@/auth/auth-context";
import { cn } from "@/lib/cn";
import { DEVELOPERS, developerOf } from "@/lib/developers";
import { useHandles } from "@/lib/handles";
import { panelClass, useDropdown } from "./dropdown";
import { PersonChip } from "./person-chip";

/**
 * Выбор исполнителей выпадающим списком.
 *
 * Список не закрывается после выбора: задача бывает на двоих, и закрывать его после
 * первого имени значило бы открывать заново ради второго. Закрывается кликом мимо.
 *
 * Вошедший стоит первым: себе задачи ставят чаще всего.
 */
export function DeveloperPicker({
  value,
  onChange,
  label = "Кто ведёт",
  placeholder = "Никто не выбран",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  placeholder?: string;
}) {
  const { open, setOpen, present, box, trigger, panel } = useDropdown<HTMLButtonElement>({
    panelHeight: 240,
  });
  const [active, setActive] = useState(0);
  const handles = useHandles();
  const me = developerOf(useCurrentUser().name);

  const people = me ? [me, ...DEVELOPERS.filter((name) => name !== me)] : [...DEVELOPERS];

  useEffect(() => {
    if (open) setActive(0);
  }, [open]);

  function toggle(name: string) {
    onChange(value.includes(name) ? value.filter((it) => it !== name) : [...value, name]);
  }

  // Клавиши на кнопке: фокус не уходит, и список не спорит с формой за него.
  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const name = people[active];
      if (name) toggle(name);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(people.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
    }
  }

  return (
    <div className="min-w-0">
      <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
        className="bg-field focus-visible:ring-accent flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm font-medium transition outline-none focus-visible:ring-2"
      >
        {value.length === 0 ? (
          <>
            <UserRound
              size={15}
              strokeWidth={2.25}
              className="text-muted-foreground shrink-0"
            />
            <span className="text-muted-foreground min-w-0 flex-1 truncate font-normal">
              {placeholder}
            </span>
          </>
        ) : (
          <span className="flex min-w-0 flex-1 flex-wrap gap-x-2.5 gap-y-1">
            {value.map((name) => (
              <span key={name} className="flex items-center gap-1.5">
                <PersonChip name={name} className="size-5 text-[10px]" />
                {name}
              </span>
            ))}
          </span>
        )}
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
            role="listbox"
            aria-multiselectable="true"
            aria-label={label}
            // Фокус остаётся на кнопке, иначе после первого выбора перестали бы
            // работать стрелки.
            onMouseDown={(event) => event.preventDefault()}
            style={{
              top: box.top,
              bottom: box.bottom,
              left: box.left,
              width: box.width,
              maxHeight: Math.min(288, box.maxHeight),
            }}
            className={cn(
              panelClass,
              "p-1.5",
              open ? "crm-pop-in" : "crm-pop-out pointer-events-none",
            )}
          >
            {people.map((name, index) => {
              const picked = value.includes(name);
              const handle = handles?.get(name);
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => toggle(name)}
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm font-medium transition",
                    index === active && "bg-muted",
                  )}
                >
                  <PersonChip name={name} />
                  <span className="min-w-0 flex-1 truncate">
                    {name}
                    {name === me && (
                      <span className="text-muted-foreground font-normal"> · я</span>
                    )}
                    {handle && (
                      <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                        @{handle}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-md",
                      picked ? "bg-surface text-accent" : "bg-black/[0.07]",
                    )}
                  >
                    {picked && <Check size={13} strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
            {value.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-muted-foreground hover:bg-muted hover:text-foreground mt-1 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-semibold transition"
              >
                <X size={14} strokeWidth={2.5} />
                Снять всех
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
