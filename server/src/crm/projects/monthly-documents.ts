import { prisma } from "../../db.js";
import { canNotify, env } from "../../env.js";
import { escapeHtml, trySendMessage } from "../../notify/telegram.js";
import { periodTitle, zonedNow } from "../../notify/zone.js";
import { formatMoney } from "../currency.js";
import { currentPeriod } from "./dto.js";

/**
 * Автодокументы: в начале месяца система сама заводит счёт и акт у каждого
 * проекта в сопровождении, чтобы не создавать их руками.
 *
 * Это записи, а не файлы: PDF требует реквизитов, нумерации и НДС, а болит «за
 * апрель забыли». Запись без суммы — нормальное состояние: сумму могли ещё не
 * назвать, и подпись «сумма не указана» считается из `null`.
 *
 * Отметка в `job_runs` — месяц, а не день, намеренно: иначе вручную удалённый
 * ошибочный счёт возвращался бы на следующее утро. Проект, ставший подходящим
 * после запуска, получит документы со следующего месяца, а текущий покажет блок
 * «Не выставлено». Прошлые месяцы не дозаполняются по той же причине.
 */

export const MONTHLY_DOCUMENTS_JOB = "monthly-documents";

/** Сообщение ограничено: 400 от телеграма код читает как «чат недоступен». */
const MAX_MESSAGE_LINES = 40;

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

interface CreatedBill {
  title: string;
  client: string | null;
  amountMinor: number | null;
  currency: "rub" | "usd";
}

function billsMessage(period: string, bills: CreatedBill[]): string {
  const lines = bills.slice(0, MAX_MESSAGE_LINES).map((bill) => {
    const amount =
      bill.amountMinor === null
        ? "сумма не указана"
        : formatMoney(bill.amountMinor, bill.currency);
    const client = bill.client ? ` · ${escapeHtml(bill.client)}` : "";
    return `• ${escapeHtml(bill.title)} — ${amount}${client}`;
  });
  const rest = bills.length - lines.length;
  if (rest > 0) lines.push(`…и ещё ${rest}`);
  return [`🧾 <b>Счета за ${periodTitle(period)}</b>`, ...lines].join("\n");
}

/** Счета уже созданы, поэтому сбой отправки только логируется и ничего не откатывает. */
async function announce(period: string, bills: CreatedBill[], log: Log): Promise<void> {
  const chatId = env.TELEGRAM_TEAM_CHAT_ID;
  if (!canNotify || !chatId || bills.length === 0) return;
  try {
    await trySendMessage(chatId, billsMessage(period, bills), log);
  } catch (cause) {
    log.warn({ err: cause }, "сообщение о счетах за месяц не отправлено");
  }
}

export async function runMonthlyDocumentsIfDue(
  log: Log,
  now = new Date(),
): Promise<void> {
  // Один момент на период и дату: иначе на границе месяца они разошлись бы.
  const timeZone = env.TIMEZONE;
  const period = currentPeriod(timeZone, now);
  const { date, time } = zonedNow(timeZone, now);

  // Первого числа ждём DIGEST_TIME, чтобы не писать в чат ночью. Со второго
  // условие снято: это и есть догон после простоя.
  if (date.endsWith("-01") && time < env.DIGEST_TIME) return;

  const previous = await prisma.jobRun.findUnique({
    where: { job: MONTHLY_DOCUMENTS_JOB },
  });
  if (previous?.ranOn === period) return;

  // Условие то же, что billingMode === "monthly": договор без галочки платится
  // этапами, договор с галочкой входит, этапы у него скрыты.
  const candidates = await prisma.project.findMany({
    where: {
      deletedAt: null,
      archivedAt: null,
      status: "active",
      OR: [{ workType: "support" }, { billingMonthly: true }],
    },
    orderBy: { title: "asc" },
    select: {
      id: true,
      title: true,
      monthlyAmountMinor: true,
      currency: true,
      startedAt: true,
      client: { select: { name: true } },
    },
  });

  // Проект, который начнётся позже, не получает документов: выставлять ещё не за
  // что, и `unbilled()` такой месяц тоже не считает.
  const projects = candidates.filter(
    (project) =>
      !project.startedAt || currentPeriod(timeZone, project.startedAt) <= period,
  );

  const existing = await prisma.invoice.findMany({
    where: { period, projectId: { in: projects.map((project) => project.id) } },
    select: { projectId: true, kind: true },
  });
  const taken = new Set(existing.map((item) => `${item.projectId}:${item.kind}`));

  const data = projects.flatMap((project) =>
    (["invoice", "act"] as const)
      .filter((kind) => !taken.has(`${project.id}:${kind}`))
      .map((kind) => ({
        projectId: project.id,
        kind,
        period,
        amountMinor: project.monthlyAmountMinor,
        currency: project.currency,
        // Запись подготовлена системой: дата нужна колонке «когда» и возрасту долга.
        issuedAt: now,
      })),
  );

  // Отметка в одной транзакции с записью и после неё, не до: сбой посреди записи
  // не должен засчитать месяц как сделанный. В дайджесте наоборот, потому что
  // рассылка долгая. skipDuplicates: между чтением и записью счёт могли завести
  // руками, поэтому верить можно только тому, что вернула база.
  const created = await prisma.$transaction(async (tx) => {
    const rows = await tx.invoice.createManyAndReturn({ data, skipDuplicates: true });
    await tx.jobRun.upsert({
      where: { job: MONTHLY_DOCUMENTS_JOB },
      create: { job: MONTHLY_DOCUMENTS_JOB, ranOn: period },
      update: { ranOn: period },
    });
    return rows;
  });

  log.info({ period, created: created.length }, "автодокументы за месяц подготовлены");

  const byId = new Map(projects.map((project) => [project.id, project]));
  const bills = created.flatMap((row): CreatedBill[] => {
    const project = byId.get(row.projectId);
    if (row.kind !== "invoice" || !project) return [];
    return [
      {
        title: project.title,
        client: project.client?.name ?? null,
        amountMinor: row.amountMinor,
        currency: row.currency,
      },
    ];
  });
  bills.sort((a, b) => a.title.localeCompare(b.title, "ru"));

  await announce(period, bills, log);
}
