import { cn } from "@/lib/cn";

/**
 * Инициалы кружком вместо аватарки.
 *
 * Фотографий у нас нет и не будет: разработчики значатся именами, а не
 * учётными записями. Кружок с буквой читается на карточке быстрее строки
 * «Егор, Вадим» и занимает меньше места.
 *
 * Цвет выводится из самого имени, а не хранится: у одного человека он всегда
 * один и тот же, а новое имя не требует ни поля в базе, ни правки палитры.
 */
const PALETTE = [
  "bg-[#dff0a6] text-[#3f5208]",
  "bg-[#cfe2fb] text-[#1d4576]",
  "bg-[#fbd9cf] text-[#7a2f18]",
  "bg-[#e2d8f8] text-[#43298a]",
  "bg-[#fce6b4] text-[#6e4a06]",
  "bg-[#c9efe2] text-[#10584a]",
] as const;

function paletteFor(name: string): string {
  // Сумма кодов символов: устойчиво к регистру ввода не нужно — имена приходят
  // из закрытого списка, а разброс на шести цветах достаточный.
  let sum = 0;
  for (const char of name) sum += char.codePointAt(0) ?? 0;
  return PALETTE[sum % PALETTE.length] ?? PALETTE[0];
}

export function PersonChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      title={name}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
        paletteFor(name),
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Несколько человек подряд, внахлёст — как список участников в трекерах. */
export function PersonChips({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span className="flex -space-x-1.5">
      {names.map((name) => (
        <PersonChip key={name} name={name} className="ring-background ring-2" />
      ))}
    </span>
  );
}
