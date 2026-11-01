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
  /** Сумма этапов в базе: по ней видно, что в поле «Общая сумма» набрано новое. */
  const [savedTotal, setSavedTotal] = useState<number | null>(null);
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
    setSavedTotal(result.totals[next] ?? null);
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

  const editable = mode === "stages";

  /**
   * Что в полях расходится с базой. Сумма по строкам точнее общей, поэтому важнее её.
   * Валюта без новых сумм идёт по строкам: общая сумма разложила бы ручную разбивку
   * поровну.
   */
  function enteredAmounts(): StageAmounts | null {
    if (!editable || stages === null) return null;
    const rows = amounts.map((value) => parseAmount(value));
    if (rows.some((value, index) => value !== stages[index]?.amountMinor)) {
      return { amounts: rows };
    }
    if (parseAmount(total) !== savedTotal) return { totalMinor: parseAmount(total) };
    return currency !== stages[0]?.currency ? { amounts: rows } : null;
  }

  async function writeAmounts(input: StageAmounts) {
    setError(null);
    setBusy(true);
    try {
      show(await saveStageAmounts(projectId, { ...input, currency }));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function writeEntered() {
    const input = enteredAmounts();
    if (input) await writeAmounts(input);
  }

  if (stages === null) {
    return error ? (
      <div className="mt-4">
        <ErrorNote>{error}</ErrorNote>
      </div>
    ) : null;
  }

  const loaded = stages;
  const anyPaid = stages.some((stage) => stage.paidAt);
  // Этапы, с которых ушли на помесячную оплату, видны только ради их оплат.
  if (mode !== "stages" && !anyPaid) return null;

  // Договор со старого API может прийти без строк: `every` на пустом дал бы true.
  const allPaid = stages.length > 0 && stages.every((stage) => stage.paidAt);
  // Заполненная сумма оплаченного этапа не меняется, а пустую вписать можно.
  const amountsOpen = stages.some((stage) => !stage.paidAt || stage.amountMinor === null);
  const totals = sumByCurrency(stages);
  const paidTotals = sumByCurrency(stages.filter((stage) => stage.paidAt));

  function run(action: () => Promise<void>) {
    action().catch((cause: unknown) => setError(failure(cause)));
  }

  /** Меняет один этап, не трогая набранное: сумма сохраняется только своей кнопкой. */
  async function patch(stage: Stage, input: Parameters<typeof updateStage>[2]) {
    const result = await updateStage(projectId, stage.position, input);
    const index = result.stages.findIndex((item) => item.id === stage.id);
    setStages(result.stages);
    setDates((current) =>
      current.map((value, at) =>
        at === index ? toDateInputValue(result.stage.issuedAt) : value,
      ),
    );
    // Валюта из ответа, а не из выбора рядом: выбранная могла быть ещё не сохранена.
    const stageCurrency = result.stages[0]?.currency ?? currency;
    const nextTotal = sumByCurrency(result.stages)[stageCurrency] ?? null;
    setSavedTotal(nextTotal);
    setTotal((current) =>
      parseAmount(current) === savedTotal ? amountToInput(nextTotal) : current,
    );
    onChanged();
  }

  async function changeStage(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  function commitDate(stage: Stage, index: number) {
    const value = dates[index] ?? "";
    if (value === toDateInputValue(stage.issuedAt)) return;
    void changeStage(() => patch(stage, { issuedAt: fromDateInputValue(value) }));
  }

  /**
   * Сумма, вписанная в строку перед отметкой, сохраняется первой: иначе этап стал бы
   * оплаченным без суммы, а итог договора занижен. Остальные строки идут как есть в
   * базе: их черновики этой отметки не касаются.
   */
  function togglePaid(stage: Stage, index: number) {
    if (stage.paidAt) {
      void changeStage(() => patch(stage, { paidAt: null }));
      return;
    }
    void changeStage(async () => {
      const typed = parseAmount(amounts[index] ?? "");
      if (editable && typed !== stage.amountMinor) {
        await saveStageAmounts(projectId, {
          amounts: loaded.map((item, at) => (at === index ? typed : item.amountMinor)),
          currency,
        });
      }
      await patch(stage, { paidAt: new Date().toISOString() });
    });
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
                  run(() => writeAmounts({ totalMinor: parseAmount(total) }));
                }}
                disabled={allPaid}
                inputMode="numeric"
                placeholder="Не указана"
              />
            </Field>
          </div>
          <CurrencySelect value={currency} onChange={setCurrency} disabled={anyPaid} />
          <Button
            type="button"
            variant="ghost"
            className="border-border border"
            onClick={() => run(() => writeAmounts({ totalMinor: parseAmount(total) }))}
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
                  onKeyDown={(event) => {
                    // Enter здесь значит «эта дата», а не «сохранить проект».
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    commitDate(stage, index);
                  }}
                  disabled={busy || !editable}
                />
              </Field>
              <StageButton
                stage={stage}
                next={stages[index + 1]}
                editable={editable}
                busy={busy}
                onToggle={() => togglePaid(stage, index)}
              />
            </div>
          </li>
        ))}
      </ul>

      {/* Общая сумма здесь тоже применяется: кнопка самая заметная в блоке, и набранное
          в верхнем поле не должно пропадать при ответе 200. */}
      {editable && amountsOpen && (
        <div className="mt-3">
          <Button
            type="button"
            onClick={() => run(writeEntered)}
            disabled={busy || enteredAmounts() === null}
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
