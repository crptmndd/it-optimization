import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
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
import { DateField } from "@/components/date-field";
import { Badge, Button, ErrorNote, Field, Input } from "@/components/ui";
import type { PaymentBlock } from "./project-billing";
import { cn } from "@/lib/cn";
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

const AMOUNTS_DISAGREE =
  "Общая сумма не сходится с суммами этапов: поправьте одно из двух или нажмите «Разделить поровну»";

/** Колонки шапки и строк одни: подписи стоят над полями только при этом условии. */
const STAGE_COLUMNS =
  "grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_8rem_8.5rem]";

function failure(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "Не удалось сохранить";
}

export function ProjectStages({
  project,
  onChanged,
  reveal,
  ref,
}: {
  project: Project;
  onChanged: () => void;
  /** Карточку открыли ради суммы: блок прокручивается на глаза. */
  reveal?: boolean;
  ref?: Ref<PaymentBlock>;
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
   * Что в полях расходится с базой. Сумма по строкам точнее общей, поэтому важнее её:
   * об их расхождении см. `amountsDisagree`. Валюта без новых сумм идёт по строкам:
   * общая сумма разложила бы ручную разбивку поровну.
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

  /** Новая общая: набрана и отличается от суммы этапов в базе. Очищенное поле не считается. */
  function totalTyped(): boolean {
    const typed = parseAmount(total);
    return typed !== null && typed !== savedTotal;
  }

  /**
   * Набраны и общая сумма, и строки, а итог не сходится. Какое из чисел настоящее, знает
   * только человек: молча победившая строка стёрла бы общую, а этап оплатился бы с
   * суммой, которой никто не называл.
   */
  function amountsDisagree(): boolean {
    if (!editable || stages === null || !totalTyped()) return false;
    const rows = amounts.map((value) => parseAmount(value));
    const touched = rows.some((value, index) => value !== stages[index]?.amountMinor);
    const sum = rows.reduce<number>((acc, value) => acc + (value ?? 0), 0);
    return touched && sum !== parseAmount(total);
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
    // ApiError: и блок, и окно проекта показывают текст только у него.
    if (amountsDisagree()) throw new ApiError(400, AMOUNTS_DISAGREE);
    const input = enteredAmounts();
    if (input) await writeAmounts(input);
  }

  useImperativeHandle(ref, () => ({ flush: writeEntered }));

  const ready = stages !== null;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal && ready) root.current?.scrollIntoView({ block: "start" });
  }, [reveal, ready]);

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

  /** Ошибка кнопки остаётся в блоке, у общего «Сохранить» её показывает окно. */
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

  function commitDate(stage: Stage, value: string) {
    if (value === toDateInputValue(stage.issuedAt)) return;
    void changeStage(() => patch(stage, { issuedAt: fromDateInputValue(value) }));
  }

  /**
   * Что набрано перед отметкой, сохраняется первым: иначе этап стал бы оплаченным без
   * суммы или не в той валюте, а заблокированный выбор показывал бы другую. Своя строка
   * важнее общей, как и в `enteredAmounts`: набранная записывается сразу, а расхождение с
   * общей остановит следующее «Сохранить суммы». Если своя не менялась, отметку
   * останавливает спор общей с черновиками других строк.
   *
   * Общая делится здесь же, пока этап не оплачен: после отметки сервер считал бы его за
   * ноль и отдал всю сумму двум другим. Очищенное поле не применяется: оно стёрло бы
   * сумму, которая видна в строке оплачиваемого этапа.
   */
  async function writeBeforePaid(stage: Stage, index: number) {
    const typed = parseAmount(amounts[index] ?? "");
    const saved = loaded.map((item) => item.amountMinor);
    if (typed !== stage.amountMinor) {
      await saveStageAmounts(projectId, {
        amounts: saved.map((value, at) => (at === index ? typed : value)),
        currency,
      });
      return;
    }
    if (amountsDisagree()) throw new ApiError(400, AMOUNTS_DISAGREE);
    const entered = enteredAmounts();
    if (entered && totalTyped()) {
      show(await saveStageAmounts(projectId, { ...entered, currency }));
    } else if (currency !== stage.currency) {
      await saveStageAmounts(projectId, { amounts: saved, currency });
    }
  }

  function togglePaid(stage: Stage, index: number) {
    if (stage.paidAt) {
      void changeStage(() => patch(stage, { paidAt: null }));
      return;
    }
    void changeStage(async () => {
      if (editable) await writeBeforePaid(stage, index);
      await patch(stage, { paidAt: new Date().toISOString() });
    });
  }

  return (
    <div ref={root} className="mt-5 scroll-mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-sm font-bold">Этапы договора</span>
        {formatTotals(totals) && (
          <span className="flex flex-wrap gap-x-3 text-[13px] font-semibold tabular-nums">
            <span>Итого {formatTotals(totals)}</span>
            {formatTotals(paidTotals) && (
              <span className="text-muted-foreground">
                оплачено {formatTotals(paidTotals)}
              </span>
            )}
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
            variant="secondary"
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

      <div
        aria-hidden="true"
        className={cn(
          STAGE_COLUMNS,
          "text-muted-foreground mt-4 hidden text-[13px] font-semibold sm:grid",
        )}
      >
        <span />
        <span>Выставлен</span>
        <span className="text-right">Сумма</span>
      </div>

      <ul className="divide-border divide-y">
        {stages.map((stage, index) => (
          <li key={stage.id} className={cn(STAGE_COLUMNS, "py-2")}>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold">Этап {stage.position}</span>
              <Badge tone={stage.paidAt ? "success" : "warning"}>
                {stage.paidAt ? `оплачено ${formatDate(stage.paidAt)}` : "не оплачено"}
              </Badge>
            </span>

            <StageField label="Выставлен">
              <DateField
                value={dates[index] ?? ""}
                onChange={(value) => {
                  setDates((current) =>
                    current.map((item, at) => (at === index ? value : item)),
                  );
                  // Выбор в календаре законченный: ждать ухода из поля тут не от чего.
                  commitDate(stage, value);
                }}
                disabled={busy || !editable}
                ariaLabel={`Выставлен этап ${stage.position}`}
              />
            </StageField>

            <StageField label="Сумма">
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
                aria-label={`Сумма этапа ${stage.position}`}
                className="text-right tabular-nums"
              />
            </StageField>

            <StageButton
              stage={stage}
              next={stages[index + 1]}
              editable={editable}
              busy={busy}
              onToggle={() => togglePaid(stage, index)}
            />
          </li>
        ))}
      </ul>

      {/* Общая сумма здесь тоже применяется: набранное в верхнем поле не должно
          пропадать при ответе 200. */}
      {editable && amountsOpen && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="secondary"
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

/** На компьютере подпись одна на столбец, в шапке; на телефоне столбцов нет. */
function StageField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="text-muted-foreground mb-1 block text-[13px] font-semibold sm:hidden">
        {label}
      </span>
      {children}
    </label>
  );
}

/** На телефоне кнопка уходит вверх, к названию этапа: поля занимают ряд целиком. */
const BUTTON_PLACE = "justify-self-end max-sm:col-start-2 max-sm:row-start-1 sm:w-full";

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
        size="sm"
        className={BUTTON_PLACE}
        onClick={onToggle}
        disabled={busy || !stage.unpayable}
      >
        {stage.unpayable ? "Снять оплату" : `Сначала этап ${next?.position}`}
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className={BUTTON_PLACE}
      onClick={onToggle}
      disabled={busy || !stage.payable}
    >
      {stage.payable || !editable ? "Оплачено" : `Сначала этап ${stage.position - 1}`}
    </Button>
  );
}
