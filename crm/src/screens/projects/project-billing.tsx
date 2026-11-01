import { useState } from "react";
import { ApiError } from "@/api/client";
import { updateProject, type Project } from "@/api/projects";
import { CurrencySelect } from "@/components/currency-select";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { amountToInput, parseAmount, sanitizeAmount, type Currency } from "@/lib/money";

/**
 * Сумма в месяц у помесячного проекта.
 *
 * Отдельный блок со своей кнопкой, а не поле общей формы: кнопка шлёт только эти
 * два значения, поэтому общий «Сохранить» их не перезапишет, а они — его.
 */
export function ProjectBilling({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: () => void;
}) {
  // Строкой, а не числом: пустое поле ввода — это "", а не 0.
  const [amount, setAmount] = useState(amountToInput(project.monthlyAmountMinor));
  const [currency, setCurrency] = useState<Currency>(project.currency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    parseAmount(amount) !== project.monthlyAmountMinor || currency !== project.currency;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await updateProject(project.id, {
        // Пустое поле — это «не задано», а не ноль.
        monthlyAmountMinor: parseAmount(amount),
        currency,
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-border border-t pt-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-32 flex-1">
          <Field label="Сумма в месяц">
            <Input
              value={amount}
              onChange={(event) => setAmount(sanitizeAmount(event.target.value))}
              onKeyDown={(event) => {
                // Enter здесь значит «эта сумма», а не «сохранить проект».
                if (event.key !== "Enter") return;
                event.preventDefault();
                void save();
              }}
              inputMode="numeric"
              placeholder="45000"
            />
          </Field>
        </div>
        <CurrencySelect value={currency} onChange={setCurrency} />
        {/* type="button": форма проекта снаружи, и submit сохранил бы её. */}
        <Button type="button" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Сохраняем…" : "Сохранить сумму"}
        </Button>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Можно с копейками: 45000 или 5,19. Пойдёт в счёт и акт следующего месяца, а в
        записи этого месяца без суммы впишется сразу.
      </p>

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}
