import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { Badge, Button, ErrorNote, Input, Select } from "@/components/ui";
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
    <div className="border-border border-t pt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Счета и акты</span>
        <Button type="button" variant="ghost" onClick={() => setAdding((it) => !it)}>
          <Plus size={15} strokeWidth={2.5} />
          Добавить
        </Button>
      </div>

      {adding && (
        <div className="bg-muted/50 mt-3 flex flex-wrap items-end gap-2 rounded-lg p-2.5">
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
            className="w-40"
          />
          <Input
            value={amount}
            onChange={(event) => setAmount(sanitizeAmount(event.target.value))}
            inputMode="numeric"
            placeholder="Сумма"
            className="w-32"
          />
          <CurrencySelect value={currency} onChange={setCurrency} />
          {/* type="button": форма проекта снаружи, и submit сохранил бы её. */}
          <Button type="button" onClick={() => void add()} disabled={saving}>
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

      <div className="mt-3">
        {items === null ? (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {mode === "monthly"
              ? "Пока ничего. Счёт и акт появятся сами в начале месяца, если проект в работе."
              : "Пока ничего."}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {items.map((invoice) => (
              <li key={invoice.id} className="py-2">
                <div className="flex items-center gap-3">
                  {invoice.kind === "act" ? (
                    <>
                      <span className="min-w-0 flex-1">
                        <RecordTitle invoice={invoice} />
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {invoice.issuedAt
                          ? `выставлен ${formatDate(invoice.issuedAt)}`
                          : "не выставлен"}
                      </span>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void togglePaid(invoice)}
                        className="min-w-0 flex-1 text-left"
                        title={
                          invoice.paidAt
                            ? "Снять отметку об оплате"
                            : "Отметить оплаченным"
                        }
                      >
                        <RecordTitle invoice={invoice} />
                      </button>

                      <Badge tone={invoice.paidAt ? "success" : "warning"}>
                        {invoice.paidAt ? "оплачен" : "не оплачен"}
                      </Badge>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() => void remove(invoice)}
                    aria-label="Удалить"
                    className="text-muted-foreground hover:bg-muted hover:text-danger shrink-0 rounded-lg p-1.5 transition"
                  >
                    <X size={15} />
                  </button>
                </div>

                {amountOf === invoice.id ? (
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
                ) : (
                  <div className="mt-1 flex items-center gap-2">
                    {invoice.amountMinor === null && <Badge>сумма не указана</Badge>}
                    <button
                      type="button"
                      onClick={() => openAmount(invoice)}
                      className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition"
                    >
                      {invoice.amountMinor === null ? "Указать сумму" : "Изменить сумму"}
                    </button>
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

function RecordTitle({ invoice }: { invoice: Invoice }) {
  return (
    <span className="block text-sm">
      <span
        className={cn("font-medium", invoice.kind === "act" && "text-muted-foreground")}
      >
        {INVOICE_KIND_LABELS[invoice.kind]}
      </span>{" "}
      за {periodLabel(invoice.period)}
      {invoice.amountMinor !== null &&
        ` — ${formatAmount(invoice.amountMinor, invoice.currency)}`}
    </span>
  );
}
