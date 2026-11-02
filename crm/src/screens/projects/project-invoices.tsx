import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { ApiError } from "@/api/client";
import {
  createInvoice,
  deleteInvoice,
  INVOICE_KIND_LABELS,
  listInvoices,
  updateInvoice,
  type Invoice,
  type InvoiceKind,
  type ProjectPayment,
} from "@/api/projects";
import { Badge, Button, ErrorNote, Input, LoadingRows, Select } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CurrencySelect } from "@/components/currency-select";
import { formatDate, periodLabel } from "@/lib/dates";
import {
  amountToInput,
  money,
  parseAmount,
  sanitizeAmount,
  type Currency,
} from "@/lib/money";

/**
 * Счета и акты по проекту.
 *
 * CRM документы не рисует — она помнит, за какой месяц что выставлено и оплачено.
 * У помесячных проектов записи заводит система в начале месяца, поэтому сумму
 * существующей записи здесь можно указать: автозапись без суммы её требует.
 *
 * Оплата есть только у счёта. Акт — документ, а не долг: с автодокументами акт
 * каждого месяца иначе стоял бы «не оплачен», и его никогда не закрыть.
 */

/** Текущий месяц как ГГГГ-ММ — им заполняется поле по умолчанию. */
function thisPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatAmount(minor: number | null, currency: Currency): string {
  return minor === null ? "" : money(minor, currency);
}

export function ProjectInvoices({
  projectId,
  defaultCurrency,
  mode,
  onChanged,
}: {
  projectId: string;
  /** Валюта проекта: счёт почти всегда в ней же, но поменять можно. */
  defaultCurrency: Currency;
  /** У договора деньги идут этапами, поэтому завести здесь можно только акт. */
  mode: ProjectPayment["mode"];
  /** Плашки оплаты на доске и в списке считает сервер: им нужен новый ответ. */
  onChanged?: () => void;
}) {
  const byStages = mode === "stages";
  const [items, setItems] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<InvoiceKind>(byStages ? "act" : "invoice");
  const [period, setPeriod] = useState(thisPeriod());
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [saving, setSaving] = useState(false);
  /** Запись, у которой сейчас открыто поле суммы. */
  const [amountOf, setAmountOf] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftCurrency, setDraftCurrency] = useState<Currency>(defaultCurrency);

  const load = useCallback(() => {
    setError(null);
    listInvoices(projectId)
      .then(setItems)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setItems([]);
      });
  }, [projectId]);

  useEffect(load, [load]);

  async function add() {
    setError(null);
    setSaving(true);
    try {
      await createInvoice(projectId, {
        kind,
        period,
        amountMinor: parseAmount(amount),
        currency,
        // Заводят запись обычно в день выставления — ставим сегодня, чтобы не
        // заполнять ещё одно поле.
        issuedAt: new Date().toISOString(),
      });
      setAmount("");
      setAdding(false);
      load();
      onChanged?.();
    } catch (cause) {
      // Повтор за тот же период сервер отклоняет с внятным текстом — показываем
      // его как есть.
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  /** Enter в этих полях значит «завести запись», а не «сохранить проект». */
  function addOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void add();
  }

  async function togglePaid(invoice: Invoice) {
    try {
      await updateInvoice(projectId, invoice.id, {
        paidAt: invoice.paidAt ? null : new Date().toISOString(),
      });
      load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    }
  }

  function openAmount(invoice: Invoice) {
    setAmountOf(invoice.id);
    setDraft(amountToInput(invoice.amountMinor));
    setDraftCurrency(invoice.currency);
  }

  async function saveAmount(invoice: Invoice) {
    setError(null);
    setSaving(true);
    try {
      await updateInvoice(projectId, invoice.id, {
        amountMinor: parseAmount(draft),
        currency: draftCurrency,
      });
      setAmountOf(null);
      load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function remove(invoice: Invoice) {
    if (!confirm(`Удалить ${INVOICE_KIND_LABELS[invoice.kind].toLowerCase()}?`)) return;
    try {
      await deleteInvoice(projectId, invoice.id);
      load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold">Счета и акты</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setAdding((it) => !it)}
        >
          <Plus size={15} strokeWidth={2.5} />
          Добавить
        </Button>
      </div>

      {adding && (
        <div className="bg-muted/50 mt-3 flex flex-wrap items-end gap-2 rounded-xl p-2.5">
          <Select
            value={kind}
            onChange={(next) => setKind(next as InvoiceKind)}
            options={[
              { value: "invoice", label: "Счёт" },
              { value: "act", label: "Акт" },
            ]}
            disabled={byStages}
            className="w-28"
          />
          <Input
            type="month"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            onKeyDown={addOnEnter}
            className="w-40"
          />
          <Input
            value={amount}
            onChange={(event) => setAmount(sanitizeAmount(event.target.value))}
            onKeyDown={addOnEnter}
            inputMode="numeric"
            placeholder="Сумма"
            className="w-32"
          />
          <CurrencySelect value={currency} onChange={setCurrency} />
          {/* type="button": форма проекта снаружи, и submit сохранил бы её. */}
          <Button
            type="button"
            variant="secondary"
            onClick={() => void add()}
            disabled={saving}
          >
            {saving ? "…" : "Готово"}
          </Button>
          {byStages && (
            <p className="text-muted-foreground w-full text-xs">
              Оплата договора идёт этапами, здесь заводятся только акты.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-2">
        {items === null ? (
          <LoadingRows rows={2} />
        ) : items.length === 0 ? (
          <p className="text-muted-foreground py-1 text-sm">
            {mode === "monthly"
              ? "Пока ничего. Счёт и акт появятся сами в начале месяца, если проект в работе."
              : "Пока ничего."}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {items.map((invoice) => (
              <li key={invoice.id} className="py-2">
                {/* Позиции заданы явно: на телефоне сумма стоит в ряду с названием, а
                    на компьютере порядок другой, и столбцы не должны зависеть от него. */}
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_9rem]">
                  <span className="min-w-0 truncate text-sm font-semibold">
                    <span
                      className={cn(invoice.kind === "act" && "text-muted-foreground")}
                    >
                      {INVOICE_KIND_LABELS[invoice.kind]}
                    </span>{" "}
                    <span className="font-medium">за {periodLabel(invoice.period)}</span>
                  </span>

                  {amountOf === invoice.id ? (
                    <span />
                  ) : invoice.amountMinor === null ? (
                    <button
                      type="button"
                      onClick={() => openAmount(invoice)}
                      className="text-muted-foreground hover:text-foreground text-right text-[13px] font-semibold underline underline-offset-2 transition sm:col-start-3 sm:row-start-1"
                    >
                      Указать сумму
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => openAmount(invoice)}
                      aria-label={`Изменить сумму: ${formatAmount(invoice.amountMinor, invoice.currency)}`}
                      title="Изменить сумму"
                      className="decoration-muted-foreground/50 hover:decoration-foreground text-right text-sm font-semibold whitespace-nowrap tabular-nums underline decoration-dotted underline-offset-4 transition sm:col-start-3 sm:row-start-1"
                    >
                      {formatAmount(invoice.amountMinor, invoice.currency)}
                    </button>
                  )}

                  <span className="min-w-0 sm:col-start-2 sm:row-start-1">
                    {invoice.kind === "act" ? (
                      <span className="text-muted-foreground block text-xs font-medium">
                        {invoice.issuedAt
                          ? `выставлен ${formatDate(invoice.issuedAt)}`
                          : "не выставлен"}
                      </span>
                    ) : (
                      <Badge tone={invoice.paidAt ? "success" : "warning"}>
                        {invoice.paidAt ? "оплачен" : "не оплачен"}
                      </Badge>
                    )}
                  </span>

                  <span className="flex items-center justify-end gap-1 sm:col-start-4 sm:row-start-1">
                    {invoice.kind === "invoice" && (
                      <Button
                        type="button"
                        variant={invoice.paidAt ? "ghost" : "secondary"}
                        size="sm"
                        onClick={() => void togglePaid(invoice)}
                      >
                        {invoice.paidAt ? "Снять оплату" : "Оплачено"}
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => void remove(invoice)}
                      aria-label="Удалить"
                      className="text-muted-foreground hover:bg-muted hover:text-danger flex size-8 shrink-0 items-center justify-center rounded-lg transition"
                    >
                      <X size={15} strokeWidth={2.25} />
                    </button>
                  </span>
                </div>

                {amountOf === invoice.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={draft}
                      onChange={(event) => setDraft(sanitizeAmount(event.target.value))}
                      onKeyDown={(event) => {
                        // Enter здесь значит «эта сумма», а не «сохранить проект».
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void saveAmount(invoice);
                      }}
                      inputMode="numeric"
                      placeholder="Сумма"
                      aria-label="Сумма записи"
                      autoFocus
                      className="w-32"
                    />
                    <CurrencySelect value={draftCurrency} onChange={setDraftCurrency} />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void saveAmount(invoice)}
                      disabled={saving}
                    >
                      {saving ? "…" : "Готово"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setAmountOf(null)}
                    >
                      Отмена
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
