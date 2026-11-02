import { Check, Wallet } from "lucide-react";
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
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  PageHeader,
  SectionTitle,
  Segmented,
} from "@/components/ui";
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

function issued(bill: Bill): string {
  return bill.issuedAt ? `выставлен ${formatDate(bill.issuedAt)}` : "не выставлен";
}

const TITLE = "block truncate text-[15px] font-semibold";
const SECONDARY = "text-muted-foreground block truncate text-[13px] font-medium";
const AMOUNT = "text-[15px] font-semibold whitespace-nowrap tabular-nums";

/*
 * Колонки включаются с xl, а не с sm: с 768px появляется боковое меню, и до 1280px
 * четырём колонкам тесно. Раньше строка в две колонки: слева кто и за что, справа
 * сумма сверху и то, что с ней делать, снизу.
 */
const ROW =
  "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5";

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
      <PageHeader title="Счета" />

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5 space-y-6">
        <div>
          <SectionTitle
            title="Не выставлено"
            count={unbilled.length}
            tone={unbilled.length > 0 ? "danger" : undefined}
          >
            {formatTotals(expected) && (
              /* Занимает остаток ряда и переносится сам: иначе две валюты на телефоне
                 выдавливают на вторую строку заголовок. */
              <span
                className={cn(
                  AMOUNT,
                  "text-muted-foreground min-w-0 flex-1 text-right whitespace-normal",
                )}
              >
                примерно {formatTotals(expected)}
              </span>
            )}
          </SectionTitle>

          {unbilled.length === 0 ? (
            <Card className="text-muted-foreground px-4 py-3.5 text-sm font-medium">
              Все помесячные проекты выставлены.
            </Card>
          ) : (
            <List>
              {unbilled.map((project) => (
                <li key={project.id} className="hover:bg-muted/60 transition-colors">
                  <Link
                    to={`/projects?open=${project.id}`}
                    className={cn(ROW, "xl:grid-cols-[minmax(0,1fr)_13rem_4.5rem_8rem]")}
                  >
                    <span className="min-w-0">
                      <span className={TITLE}>{project.title}</span>
                      <span className={SECONDARY}>{project.client?.name}</span>
                    </span>
                    <span
                      className={cn(SECONDARY, "max-xl:col-start-1 max-xl:row-start-2")}
                    >
                      {unbilledSince(project)}
                    </span>
                    <Badge
                      tone="danger"
                      className="justify-self-end max-xl:col-start-2 max-xl:row-start-2"
                    >{`${project.unbilledCount} мес.`}</Badge>
                    <span
                      className={cn(
                        AMOUNT,
                        "text-right max-xl:col-start-2 max-xl:row-start-1 max-xl:self-start",
                      )}
                    >
                      {project.monthlyAmountMinor !== null &&
                        money(
                          project.monthlyAmountMinor * project.unbilledCount,
                          project.currency,
                        )}
                    </span>
                  </Link>
                </li>
              ))}
            </List>
          )}
        </div>

        <div>
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            {/* Число только у открытого среза: остальные сервер не считает, а лишний
                запрос ради подписи на кнопке того не стоит. */}
            <Segmented
              value={scope}
              onChange={(value) => setScope(value as BillScope)}
              ariaLabel="Срез счетов"
              options={SCOPES.map((item) =>
                item.value === scope && bills ? { ...item, count: bills.length } : item,
              )}
            />
            {formatTotals(totals) && (
              <span className={cn(AMOUNT, "flex items-center gap-1.5 px-1")}>
                <Wallet size={16} strokeWidth={2.25} />
                {formatTotals(totals)}
              </span>
            )}
          </div>

          {bills === null ? (
            <LoadingRows />
          ) : bills.length === 0 ? (
            <EmptyState {...EMPTY[scope]} />
          ) : (
            <List>
              {bills.map((bill) => (
                <BillRow
                  key={`${bill.source}:${bill.id}`}
                  bill={bill}
                  showStatus={scope !== "due"}
                  pending={pending === bill.id}
                  onToggle={() => void togglePaid(bill)}
                />
              ))}
            </List>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Вся строка ведёт в карточку проекта, но кнопка оплаты стоит рядом с содержимым, а не
 * внутри ссылки: кнопка в ссылке — недопустимая разметка. Поэтому ссылка лежит слоем
 * поверх строки, а кнопка поднята над ней. Иначе сумма и кнопка на телефоне не встанут
 * в свою колонку справа.
 */
function BillRow({
  bill,
  showStatus,
  pending,
  onToggle,
}: {
  bill: Bill;
  /** В срезе «К оплате» все строки не оплачены, и такая плашка ничего не сообщает. */
  showStatus: boolean;
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
  const client = bill.project.client ?? "без клиента";

  return (
    <li
      className={cn(
        ROW,
        "hover:bg-muted/60 relative transition-colors xl:grid-cols-[minmax(0,1fr)_10.5rem_10.5rem_9rem]",
      )}
    >
      <Link
        to={`/projects?open=${bill.project.id}`}
        aria-label={`${client}, ${bill.project.title}`}
        className="absolute inset-0 focus-visible:-outline-offset-2"
      />

      <span className="min-w-0">
        <span className={cn(TITLE, !bill.project.client && "text-muted-foreground")}>
          {client}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className={SECONDARY}>{bill.project.title}</span>
          {bill.project.archived && <Badge>архив</Badge>}
        </span>
      </span>

      <span className="min-w-0 max-xl:col-start-1 max-xl:row-start-2">
        <span className="block truncate text-[13px] font-semibold">{subject(bill)}</span>
        <span className={cn(SECONDARY, "max-xl:whitespace-normal")}>{issued(bill)}</span>
      </span>

      <span className="flex flex-col items-end gap-1 max-xl:col-start-2 max-xl:row-start-1 max-xl:self-start">
        {bill.amountMinor === null ? (
          <span className="text-muted-foreground text-[13px] font-medium whitespace-nowrap">
            сумма не указана
          </span>
        ) : (
          <span className={AMOUNT}>{money(bill.amountMinor, bill.currency)}</span>
        )}
        {showStatus && (
          <Badge tone={bill.paidAt ? "success" : "warning"}>
            {bill.paidAt ? `оплачен ${formatDate(bill.paidAt)}` : "не оплачен"}
          </Badge>
        )}
      </span>

      <Button
        type="button"
        variant={bill.paidAt ? "ghost" : "secondary"}
        size="sm"
        className="relative max-xl:col-start-2 max-xl:row-start-2 max-xl:self-end xl:w-full"
        onClick={onToggle}
        disabled={pending || !allowed}
      >
        {allowed && !bill.paidAt && <Check size={15} strokeWidth={2.25} />}
        {label}
      </Button>
    </li>
  );
}
