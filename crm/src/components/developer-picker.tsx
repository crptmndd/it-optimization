import { DEVELOPERS } from "@/lib/developers";
import { cn } from "@/lib/cn";

/**
 * Кто ведёт — кнопками, а не выпадающим списком с множественным выбором.
 * Разработчиков немного: весь состав виден сразу, отметить двоих — два клика
 * вместо возни с Ctrl, а на телефоне множественный выбор в `select` вообще
 * работает по-разному в каждом браузере.
 */
export function DeveloperPicker({
  value,
  onChange,
  label = "Кто ведёт",
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string;
  hint?: string;
}) {
  function toggle(name: string) {
    onChange(value.includes(name) ? value.filter((it) => it !== name) : [...value, name]);
  }

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-2">
        {DEVELOPERS.map((name) => {
          const picked = value.includes(name);
          return (
            <button
              key={name}
              type="button"
              onClick={() => toggle(name)}
              aria-pressed={picked}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm font-medium transition",
                picked
                  ? "border-accent-border bg-accent-soft text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
      <p className="text-muted-foreground mt-1.5 text-sm">
        {value.length === 0 ? "Никто не выбран — в сводке будет «ничья»" : hint}
      </p>
    </div>
  );
}
