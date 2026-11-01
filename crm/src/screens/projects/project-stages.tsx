import { useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import {
  getStages,
  saveStageAmounts,
  updateStage,
  type Project,
  type Stage,
  type StageAmounts,
  type StagesResult,
} from "@/api/projects";
import { CurrencySelect } from "@/components/currency-select";
import { Badge, Button, ErrorNote, Field, Input } from "@/components/ui";
import { formatDate, fromDateInputValue, toDateInputValue } from "@/lib/dates";
import {
  amountToInput,
  formatTotals,
  parseAmount,
  sanitizeAmount,
  sumByCurrency,
  type Currency,
} from "@/lib/money";

/**
 * Этапы договора: общая сумма, три части и отметки оплаты.
 *
 * Порядок оплаты проверяет сервер, здесь кнопка только повторяет его ответ:
 * `payable` и `unpayable` приходят вместе с этапами, чтобы правило не жило в двух
 * приложениях. Все кнопки `type="button"`: снаружи форма проекта.
 */

function failure(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "Не удалось сохранить";
}

export function ProjectStages({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [total, setTotal] = useState("");
  const [amounts, setAmounts] = useState<string[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  // Из этапов, а не из проекта: у оплаченной суммы валюта своя.
  const [currency, setCurrency] = useState<Currency>(project.currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(result: StagesResult) {
    const next = result.stages[0]?.currency ?? project.currency;
    setStages(result.stages);
    setCurrency(next);
    setAmounts(result.stages.map((stage) => amountToInput(stage.amountMinor)));
    setDates(result.stages.map((stage) => toDateInputValue(stage.issuedAt)));
    setTotal(amountToInput(result.totals[next] ?? null));
  }

  const projectId = project.id;
  const mode = project.payment.mode;
  useEffect(() => {
    let stale = false;
    getStages(projectId)
      .then((result) => {
        if (!stale) show(result);
      })
      .catch((cause: unknown) => {
        if (!stale) setError(failure(cause));
      });
    return () => {
      stale = true;
    };
    // Режим в зависимостях: смена вида работы создаёт этапы на сервере.
  }, [projectId, mode]);

  if (stages === null) {
    return error ? (
      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
    ) : null;
  }

  const anyPaid = stages.some((stage) => stage.paidAt);
  // Этапы, с которых ушли на помесячную оплату, видны только ради их оплат.
  if (mode !== "stages" && !anyPaid) return null;

  const editable = mode === "stages";
  // Договор со старого API может прийти без строк: `every` на пустом дал бы true.
  const allPaid = stages.length > 0 && stages.every((stage) => stage.paidAt);
  const totals = sumByCurrency(stages);
  const paidTotals = sumByCurrency(stages.filter((stage) => stage.paidAt));

  async function saveAmounts(input: StageAmounts) {
    setError(null);
    setBusy(true);
    try {
      show(await saveStageAmounts(projectId, { ...input, currency }));
      onChanged();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  /** Меняет один этап, не трогая набранное в остальных строках. */
  async function patch(stage: Stage, input: Parameters<typeof updateStage>[2]) {
    setError(null);
    setBusy(true);
    try {
      const result = await updateStage(projectId, stage.position, input);
      const index = result.stages.findIndex((item) => item.id === stage.id);
      setStages(result.stages);
      setDates((current) =>
        current.map((value, at) =>
          at === index ? toDateInputValue(result.stage.issuedAt) : value,
        ),
      );
      setAmounts((current) =>
        current.map((value, at) =>
          at === index ? amountToInput(result.stage.amountMinor) : value,
        ),
      );
      onChanged();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  function commitDate(stage: Stage, index: number) {
    const value = dates[index] ?? "";
    if (value === toDateInputValue(stage.issuedAt)) return;
    void patch(stage, { issuedAt: fromDateInputValue(value) });
  }

  return (
    <div className="border-border mt-4 border-t pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-medium">Этапы договора</span>
        {formatTotals(totals) && (
          <span className="text-muted-foreground text-xs">
            Итого {formatTotals(totals)}
            {formatTotals(paidTotals) && ` · оплачено ${formatTotals(paidTotals)}`}
          </span>
        )}
      </div>

      {editable ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-32 flex-1">
            <Field label="Общая сумма">
              <Input
                value={total}
                onChange={(event) => setTotal(sanitizeAmount(event.target.value))}
                onKeyDown={(event) => {
                  // Enter здесь значит «эта сумма», а не «сохранить проект».
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  void saveAmounts({ totalMinor: parseAmount(total) });
                }}
                inputMode="numeric"
                placeholder="300000"
              />
            </Field>
          </div>
          <CurrencySelect value={currency} onChange={setCurrency} disabled={anyPaid} />
          <Button
            type="button"
            variant="ghost"
            className="border-border border"
            onClick={() => void saveAmounts({ totalMinor: parseAmount(total) })}
            disabled={busy || allPaid}
          >
            Разделить поровну
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">
          {mode === "monthly" && "Проект платится помесячно. "}
          Этапы остались из-за оплат: их можно только снять.
        </p>
      )}

      <ul className="mt-3 space-y-2">
        {stages.map((stage, index) => (
          <li key={stage.id} className="border-border rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Этап {stage.position}</span>
              <span className="flex items-center gap-2">
                {stage.paidAt && (
                  <span className="text-muted-foreground text-xs">
                    {formatDate(stage.paidAt)}
                  </span>
                )}
                <Badge tone={stage.paidAt ? "success" : "warning"}>
                  {stage.paidAt ? "оплачено" : "не оплачено"}
                </Badge>
              </span>
            </div>

            <div className="mt-2 grid items-end gap-2 sm:grid-cols-[1fr_1fr_9.5rem]">
              <Field label="Сумма">
                <Input
                  value={amounts[index] ?? ""}
                  onChange={(event) => {
                    const value = sanitizeAmount(event.target.value);
                    setAmounts((current) =>
                      current.map((item, at) => (at === index ? value : item)),
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  // Заполненная сумма оплаченного этапа не меняется, а пустую
                  // вписать можно: оплатить этап без суммы разрешено.
                  disabled={!editable || (!!stage.paidAt && stage.amountMinor !== null)}
                  inputMode="numeric"
                  placeholder="Не указана"
                />
              </Field>
              <Field label="Выставлен">
                <Input
                  type="date"
                  value={dates[index] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDates((current) =>
                      current.map((item, at) => (at === index ? value : item)),
                    );
                  }}
                  onBlur={() => commitDate(stage, index)}
                  disabled={busy || !editable}
                />
              </Field>
              <StageButton
                stage={stage}
                next={stages[index + 1]}
                editable={editable}
                busy={busy}
                onToggle={() =>
                  void patch(stage, {
                    paidAt: stage.paidAt ? null : new Date().toISOString(),
                  })
                }
              />
            </div>
          </li>
        ))}
      </ul>

      {editable && stages.length > 0 && (
        <div className="mt-3">
          <Button
            type="button"
            onClick={() =>
              void saveAmounts({ amounts: amounts.map((value) => parseAmount(value)) })
            }
            disabled={busy}
          >
            {busy ? "Сохраняем…" : "Сохранить суммы"}
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}

/** Запрещённая кнопка сама называет причину: подсказка в title на телефоне не видна. */
function StageButton({
  stage,
  next,
  editable,
  busy,
  onToggle,
}: {
  stage: Stage;
  next: Stage | undefined;
  editable: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  if (stage.paidAt) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="border-border border"
        onClick={onToggle}
        disabled={busy || !stage.unpayable}
      >
        {stage.unpayable ? "Снять оплату" : `Сначала этап ${next?.position}`}
      </Button>
    );
  }
  return (
    <Button type="button" onClick={onToggle} disabled={busy || !stage.payable}>
      {stage.payable || !editable ? "Оплачено" : `Сначала этап ${stage.position - 1}`}
    </Button>
  );
}
