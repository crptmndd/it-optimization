import { useCurrentUser } from "@/auth/auth-context";
import { cn } from "@/lib/cn";
import { DEVELOPERS, developerOf } from "@/lib/developers";
import { PersonChip } from "./person-chip";

/**
 * Фильтр по человеку рядом кружками: людей четверо, и выпадающий список прятал бы
 * ровно то, что можно показать сразу. Повторное нажатие снимает фильтр.
 */
export function PeopleFilter({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const me = developerOf(useCurrentUser().name);
  const people = me ? [me, ...DEVELOPERS.filter((name) => name !== me)] : [...DEVELOPERS];

  return (
    <div
      role="group"
      aria-label="Исполнитель"
      className={cn("flex h-10 shrink-0 items-center gap-1", className)}
    >
      {people.map((name) => {
        const picked = value === name;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={picked}
            aria-label={name === me ? `${name} (я)` : name}
            title={name}
            onClick={() => onChange(picked ? "" : name)}
            className={cn(
              "flex items-center gap-1.5 rounded-full p-0.5 text-[13px] font-semibold transition",
              picked
                ? "bg-surface text-surface-foreground pr-3"
                : value
                  ? "opacity-45 hover:opacity-100"
                  : "hover:bg-black/[0.06]",
            )}
          >
            <PersonChip name={name} className="size-8 text-[13px]" />
            {picked && name}
          </button>
        );
      })}
    </div>
  );
}
