import { CLOSED_PROJECT_STATUSES, type Project } from "@/api/projects";
import { monthLabel } from "@/lib/dates";
import { money } from "@/lib/money";

/**
 * Состояние оплаты одной строкой — для доски, списка и карточки клиента.
 *
 * Правило «как платит проект» считает сервер (`payment.mode`), здесь только
 * подпись к его ответу.
 */

export type PaymentTone = "neutral" | "success" | "warning" | "danger";

export interface PaymentSummary {
  label: string;
  tone: PaymentTone;
}

/** Для текста вне бейджа: на доске подпись стоит в ряду с остальными сведениями. */
export const PAYMENT_TEXT_CLASS: Record<PaymentTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

const MONTHLY: Record<"paid" | "unpaid" | "missing", PaymentSummary> = {
  paid: { label: "оплачен", tone: "success" },
  unpaid: { label: "не оплачен", tone: "warning" },
  missing: { label: "нет счёта", tone: "danger" },
};

export function paymentSummary(
  project: Pick<Project, "payment" | "status">,
): PaymentSummary | null {
  const { stages, monthly } = project.payment;
  const closed = CLOSED_PROJECT_STATUSES.includes(project.status);

  if (stages) {
    // Пустые этапы создала миграция у давно закрытых договоров: «этапы 0/3» на
    // них выглядело бы долгом, которого нет.
    const empty = stages.paid === 0 && stages.next?.amountMinor == null;
    if (stages.total === 0 || (closed && empty)) return null;

    const next = stages.next;
    return {
      label:
        `этапы ${stages.paid}/${stages.total}` +
        (next?.amountMinor != null
          ? ` · следующий ${money(next.amountMinor, next.currency)}`
          : ""),
      tone: next ? "neutral" : "success",
    };
  }

  if (monthly) {
    const { label, tone } = MONTHLY[monthly.status];
    return { label: `${monthLabel(monthly.period)}: ${label}`, tone };
  }

  return null;
}
