import { Card, Segmented } from "@/components/ui";
import { cn } from "@/lib/cn";
import { setThemeChoice, useThemeChoice, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Как в системе" },
  { value: "light", label: "Светлая" },
  { value: "dark", label: "Тёмная" },
];

/**
 * Строкой во всю ширину, а не третьей карточкой в сетке: у админа она оставалась одна
 * в ряду с пустой половиной справа. Выбор справа от текста, на телефоне под ним.
 */
export function AppearancePanel({ className }: { className?: string }) {
  const choice = useThemeChoice();

  return (
    <Card
      className={cn(
        "flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[17px] leading-6 font-bold tracking-tight">Оформление</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          «Как в системе» меняет тему вместе с телефоном или компьютером. Выбор
          запоминается на этом устройстве.
        </p>
      </div>
      <Segmented
        value={choice}
        onChange={(value) => setThemeChoice(value as ThemeChoice)}
        options={OPTIONS}
        ariaLabel="Тема"
        className="self-start sm:self-center"
      />
    </Card>
  );
}
