import { isAdmin, useCurrentUser } from "@/auth/auth-context";
import { cn } from "@/lib/cn";
import { pickablePeople, usePeople } from "@/lib/people";
import { PersonChip } from "./person-chip";

/** Сколько кружков помещается на телефоне в одну строку с поиском и видом списка. */
const PHONE_ROW = 4;

/**
 * Фильтр по человеку рядом кружками: людей немного, и выпадающий список прятал бы ровно
 * то, что можно показать сразу. Повторное нажатие снимает фильтр.
 *
 * Сотруднику не показывается нигде: он и так видит только своё, а сервер игнорирует
 * выбор. Проверка здесь, а не в экранах, чтобы новый экран не мог о ней забыть.
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
  const user = useCurrentUser();
  const team = usePeople();
  if (!isAdmin(user)) return null;

  const me = user.memberName;
  const people = pickablePeople(team, me, value ? [value] : []);

  return (
    <div
      role="group"
      aria-label="Исполнитель"
      className={cn(
        "flex h-10 shrink-0 items-center gap-1",
        // На телефоне четверо ещё помещаются в ряд с поиском. Дальше кружки наезжали бы
        // на него, поэтому фильтр занимает свою строку, а если и её мало, едет вбок.
        people.length > PHONE_ROW && "max-sm:w-full max-sm:overflow-x-auto",
        className,
      )}
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
              "flex shrink-0 items-center gap-1.5 rounded-full p-0.5 text-[13px] font-semibold transition",
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
