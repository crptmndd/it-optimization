import { Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import {
  listBills,
  updateInvoice,
  updateStage,
  type Bill,
  type BillScope,
  type Project,
} from "@/api/projects";
import { getToday } from "@/api/today";
import { Badge, Button, EmptyState, ErrorNote } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDate, periodLabel } from "@/lib/dates";
import { formatTotals, money, sumByCurrency, type Currency } from "@/lib/money";

/**
 * Счета: кто, когда и за что платит.
 *
 * Строка — это счёт либо этап договора, разницу знают только `bills.ts` на
 * сервере и кнопка оплаты здесь. Блок «Не выставлено» отделён намеренно:
 * невыставленный счёт зависит от нас, а неоплаченный — от клиента, и делать с
 * ними надо разное.
 */

const SCOPES: { value: BillScope; label: string }[] = [
  { value: "due", label: "К оплате" },
  { value: "paid", label: "Оплачено" },
  { value: "all", label: "Все" },
];

const EMPTY: Record<BillScope, { title: string; note: string }> = {
  due: { title: "Долгов нет", note: "Всё выставленное оплачено." },
  paid: { title: "Оплат пока нет", note: "Здесь появятся оплаченные счета и этапы." },
  all: {
    title: "Счетов пока нет",
    note: "Они появятся сами в начале месяца или из карточки проекта.",
  },
};

/** «Этап 2 из 3» либо месяц: то, за что платят. */
function subject(bill: Bill): string {
  if (bill.stage) return `Этап ${bill.stage.position} из ${bill.stage.total}`;
  return bill.period ? periodLabel(bill.period) : "";
}

/** Как на «Сегодня»: месяц в именительном падеже после «с» читается как опечатка. */
function unbilledSince(project: Project): string {
  const first = periodLabel(project.unbilledPeriod ?? "");
  return project.unbilledCount > 1 ? `первый пропуск: ${first}` : `за ${first}`;
}

function dates(bill: Bill): string {
  const parts = [
    bill.issuedAt ? `выставлен ${formatDate(bill.issuedAt)}` : "не выставлен",
    bill.paidAt ? `оплачен ${formatDate(bill.paidAt)}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function InvoicesScreen() {
  const [scope, setScope] = useState<BillScope>("due");
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [totals, setTotals] = useState<Partial<Record<Currency, number>>>({});
  const [unbilled, setUnbilled] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  /** Ответ за прошлый срез не должен лечь поверх уже выбранного. */
  const request = useRef(0);

  const load = useCallback(() => {
    const current = (request.current += 1);
    listBills(scope)
      .then((result) => {
        if (current !== request.current) return;
        setBills(result.invoices);
        setTotals(result.totals);
      })
      .catch((cause: unknown) => {
        if (current !== request.current) return;
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setBills([]);
      });

    // Невыставленное считает сервер и отдаёт в сводке — второй источник тех же
    // данных разошёлся бы с первым.
    getToday()
      .then((snapshot) => setUnbilled(snapshot.projects.unbilled))
      .catch(() => setUnbilled([]));
  }, [scope]);

  useEffect(() => {
    setError(null);
    load();
  }, [load]);

  async function togglePaid(bill: Bill) {
    const paidAt = bill.paidAt ? null : new Date().toISOString();
    setError(null);
    setPending(bill.id);
    try {
      if (bill.stage) {
        await updateStage(bill.project.id, bill.stage.position, { paidAt });
      } else {
        await updateInvoice(bill.project.id, bill.id, { paidAt });
      }
      load();
    } catch (cause) {
      // Отказ по порядку оплаты сервер формулирует сам — показываем как есть.
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setPending(null);
    }
  }

  // Ожидаемое за невыставленные месяцы — по каждой валюте отдельно: сложить
  // рубли с долларами нечем, курса у CRM нет.
  const expected = sumByCurrency(
    unbilled.map((project) => ({
      amountMinor: (project.monthlyAmountMinor ?? 0) * project.unbilledCount,
      currency: project.currency,
    })),
  );

  return (
    <section>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Счета</h1>
        <p className="text-muted-foreground mt-1 text-sm">Кто, когда и за что платит.</p>
      </header>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 space-y-8">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 className="text-danger text-sm font-semibold">Не выставлено</h2>
            <span className="text-muted-foreground text-xs">{unbilled.length}</span>
            {formatTotals(expected) && (
              <span className="text-muted-foreground ml-auto text-sm">
                примерно {formatTotals(expected)}
              </span>
            )}
          </div>

          {unbilled.length === 0 ? (
            <p className="text-muted-foreground mt-2 text-sm">
              Все помесячные проекты выставлены.
            </p>
          ) : (
            <ul className="mt-2 space-y-3 sm:space-y-2">
              {unbilled.map((project) => (
                <li
                  key={project.id}
                  className="border-border bg-danger-soft flex items-center gap-3 rounded-xl border px-3 py-3 sm:py-2.5"
                >
                  <Link to={`/projects?open=${project.id}`} className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {project.title}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                      {[project.client?.name, unbilledSince(project)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Link>
                  <Badge tone="danger">
                    {project.unbilledCount > 1
                      ? `${project.unbilledCount} мес.`
                      : "1 мес."}
                  </Badge>
                  {project.monthlyAmountMinor !== null && (
                    <span className="text-sm font-medium">
                      {money(
                        project.monthlyAmountMinor * project.unbilledCount,
                        project.currency,
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div
              role="group"
              aria-label="Срез счетов"
              className="border-border flex shrink-0 overflow-hidden rounded-lg border"
            >
              {SCOPES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={scope === item.value}
                  onClick={() => setScope(item.value)}
                  className={cn(
                    "px-3 py-1.5 text-sm font-medium transition",
                    scope === item.value
                      ? "bg-accent-soft text-foreground"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span className="text-muted-foreground text-xs">{bills?.length ?? 0}</span>
            {formatTotals(totals) && (
              <span className="ml-auto flex items-center gap-1.5 text-sm font-medium">
                <Wallet size={14} strokeWidth={2.5} />
                {formatTotals(totals)}
              </span>
            )}
          </div>

          {bills === null ? (
            <p className="text-muted-foreground mt-3 text-sm">Загружаем…</p>
          ) : bills.length === 0 ? (
            <div className="mt-3">
              <EmptyState {...EMPTY[scope]} />
            </div>
          ) : (
            <ul className="mt-3 space-y-3 sm:space-y-2">
              {bills.map((bill) => (
                <BillRow
                  key={`${bill.source}:${bill.id}`}
                  bill={bill}
                  pending={pending === bill.id}
                  onToggle={() => void togglePaid(bill)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function BillRow({
  bill,
  pending,
  onToggle,
}: {
  bill: Bill;
  pending: boolean;
  onToggle: () => void;
}) {
  const stage = bill.stage;
  const allowed = !stage || (bill.paidAt ? stage.unpayable : stage.payable);
  // Запрещённая кнопка сама называет причину: подсказка в title на телефоне не видна.
  const label = !allowed
    ? `Сначала этап ${stage?.blockedBy}`
    : bill.paidAt
      ? "Снять оплату"
      : "Оплачено";

  return (
    <li className="border-border bg-background flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-3 sm:py-2.5">
      <Link to={`/projects?open=${bill.project.id}`} className="min-w-0 flex-1 basis-56">
        <span
          className={cn(
            "block truncate text-sm font-medium",
            !bill.project.client && "text-muted-foreground",
          )}
        >
          {bill.project.client ?? "без клиента"}
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {bill.project.title} · {subject(bill)}
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {dates(bill)}
        </span>
      </Link>

      <span className="flex flex-wrap items-center gap-2">
        {bill.amountMinor === null ? (
          <Badge>сумма не указана</Badge>
        ) : (
          <span className="text-sm font-medium whitespace-nowrap">
            {money(bill.amountMinor, bill.currency)}
          </span>
        )}
        <Badge tone={bill.paidAt ? "success" : "warning"}>
          {bill.paidAt ? "оплачен" : "не оплачен"}
        </Badge>
        {bill.project.archived && <Badge>архив</Badge>}
      </span>

      <Button
        type="button"
        variant={bill.paidAt ? "ghost" : "primary"}
        className={cn("sm:w-36", bill.paidAt && "border-border border")}
        onClick={onToggle}
        disabled={pending || !allowed}
      >
        {label}
      </Button>
    </li>
  );
}
