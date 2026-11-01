import { formatMoney } from "../crm/currency.js";
import type { BillDto } from "../crm/projects/bills.js";
import { collectToday, isQuietSnapshot } from "../crm/today.js";
import { env } from "../env.js";
import { escapeHtml, sendMessage, TelegramError } from "./telegram.js";
import { daysOverdue, daysUntil, periodTitle, pluralDays } from "./zone.js";

/**
 * Утренняя сводка в общий чат.
 *
 * Личных дайджестов нет: исполнители значатся именами, а не учётками, так что
 * «что делать мне» система вычислить не может. Зато у каждой строки указано, на
 * ком она висит, — в общем чате команды это и нужно.
 *
 * Если напоминать не о чем, сообщение не отправляется вовсе. Ежедневное «всё
 * чисто» приучает не открывать бота, и тогда важное сообщение тоже пролистают.
 * Молчание здесь — сигнал, что всё в порядке.
 */

interface Log {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  error: (obj: unknown, msg: string) => void;
}

/**
 * Предел строк в блоке и символов в сообщении. Телеграм не принимает текст длиннее
 * 4096 символов, а его ошибку 400 код читает как «чат недоступен»: сводка молча
 * пропала бы как раз в тот день, когда горит больше всего.
 */
const MAX_LINES = 15;
const MAX_MESSAGE_LENGTH = 4000;

/** «· Егор, Вадим» или «· ничья» — кто отвечает, приписью в конце строки. */
function who(names: string[], nobody: string): string {
  return names.length
    ? ` · ${names.map(escapeHtml).join(", ")}`
    : ` · <i>${nobody}</i>`;
}

function lateSuffix(date: Date | null): string {
  if (!date) return "";
  const days = daysOverdue(date, env.TIMEZONE);
  // «Просрочено на 0 дней» — бессмыслица: срок был вчера вечером, значит счёт
  // идёт со вчера, и правильнее промолчать про длительность.
  return days > 0 ? ` — ${pluralDays(days)}` : "";
}

function block(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const rest = lines.length - MAX_LINES;
  return [
    `<b>${title}</b>`,
    ...lines.slice(0, MAX_LINES),
    ...(rest > 0 ? [`…и ещё ${rest}`] : []),
    "",
  ];
}

/**
 * Режем по строкам, а не по символам: каждая строка сама закрывает свои теги, и
 * обрезка посреди строки дала бы ту же ошибку 400. Срезается низ сводки: блоки
 * там стоят по убыванию срочности.
 */
function fitMessage(lines: string[]): string {
  const text = lines.join("\n").trimEnd();
  if (text.length <= MAX_MESSAGE_LENGTH) return text;

  const tail = "…не всё поместилось, остальное в CRM";
  const kept: string[] = [];
  let length = tail.length;
  for (const line of lines) {
    length += line.length + 1;
    if (length > MAX_MESSAGE_LENGTH) break;
    kept.push(line);
  }
  return [...kept, tail].join("\n");
}

export async function buildDigest(): Promise<string | null> {
  const snapshot = await collectToday();
  // Не `isEmptySnapshot`: далёкое продление — не повод писать в чат. Разницу
  // между двумя проверками см. у них самих.
  if (isQuietSnapshot(snapshot)) return null;

  const { tasks, credentials, projects, money } = snapshot;

  const credentialLine = (item: (typeof credentials.urgent)[number]) => {
    const left = item.renewsAt ? daysUntil(item.renewsAt, env.TIMEZONE) : 0;
    const late = item.renewsAt ? daysOverdue(item.renewsAt, env.TIMEZONE) : 0;
    const when = late > 0
      ? ` — <b>истёк ${pluralDays(late)} назад</b>`
      : left === 0
        ? " — <b>сегодня</b>"
        : ` — через ${pluralDays(left)}`;
    // Сумма прямо в напоминании: «пора продлить» без цены заставляет лезть
    // в CRM ровно за одной цифрой.
    const price = item.amountMinor
      ? ` — ${formatMoney(item.amountMinor, item.currency)}${item.monthlyFee ? "/мес" : ""}`
      : "";
    const login = item.login ? ` · ${escapeHtml(item.login)}` : "";
    return `• ${escapeHtml(item.service)}${when}${price}${login}${who(
      item.owner ? [item.owner] : [],
      "ни на кого не оформлен",
    )}`;
  };

  const taskLine = (task: (typeof tasks.overdue)[number], withLate: boolean) => {
    const where = task.project ? ` <i>${escapeHtml(task.project.title)}</i>` : "";
    const late = withLate ? lateSuffix(task.dueAt) : "";
    const urgent = task.priority === "high" ? "❗ " : "";
    return `• ${urgent}${escapeHtml(task.title)}${where}${late}${who(task.developers, "ничья")}`;
  };

  const billLine = (bill: BillDto) => {
    const what = bill.stage
      ? `этап ${bill.stage.position} из ${bill.stage.total}`
      : periodTitle(bill.period ?? "");
    const amount =
      bill.amountMinor === null
        ? "сумма не указана"
        : formatMoney(bill.amountMinor, bill.currency);
    const client = bill.project.client ? ` · ${escapeHtml(bill.project.client)}` : "";
    return `• ${escapeHtml(bill.project.title)} (${what}) — ${amount}${client}`;
  };

  const blocks = [
    ...block(
      `Задачи просрочены (${tasks.overdue.length})`,
      tasks.overdue.map((task) => taskLine(task, true)),
    ),
    ...block(
      `Задачи на сегодня (${tasks.today.length})`,
      tasks.today.map((task) => taskLine(task, false)),
    ),
    ...block(
      `Без исполнителя (${tasks.unassigned.length})`,
      tasks.unassigned.map((task) => taskLine(task, false)),
    ),
    ...block(
      `Проекты — срок (${projects.urgent.length})`,
      projects.urgent.map((project) => {
        const client = project.client ? ` — ${escapeHtml(project.client.name)}` : "";
        return `• ${escapeHtml(project.title)}${client}${lateSuffix(project.deadline)}${who(
          project.developers,
          "никто не ведёт",
        )}`;
      }),
    ),
    // Продления идут перед деньгами: пропущенный счёт — отложенные деньги,
    // а истёкший домен — лежащий сайт, свой или клиентский.
    ...block(
      `🔑 Продлить (${credentials.urgent.length})`,
      credentials.urgent.map(credentialLine),
    ),
    // Деньги последними, но со значком: забытый счёт — это недополученные
    // деньги, и среди сроков его легко пролистать.
    ...block(
      `💸 Счета не выставлены (${projects.unbilled.length})`,
      projects.unbilled.map((project) => {
        const amount = project.monthlyAmountMinor
          ? ` — ${formatMoney(project.monthlyAmountMinor, project.currency)}`
          : "";
        const client = project.client ? ` · ${escapeHtml(project.client.name)}` : "";
        // Сколько месяцев пропущено — важнее самого раннего: один месяц это
        // забывчивость, четыре — потерянные деньги.
        const first = periodTitle(project.unbilledPeriod);
        const months =
          project.unbilledCount > 1
            ? ` (${project.unbilledCount} мес., первый пропуск: ${first})`
            : ` (за ${first})`;
        return `• ${escapeHtml(project.title)}${months}${amount}${client}`;
      }),
    ),
    // Только давние: свежий счёт — обычное дело, клиент платит не в тот же день.
    ...block(
      `⏳ Не оплачено (${money.unpaidUrgent.length})`,
      money.unpaidUrgent.map(billLine),
    ),
    // Самый низ и без значка — это справка, а не повод действовать сегодня.
    // Сводку такие строки не поднимают (см. `isQuietSnapshot`), но раз она уже
    // вышла, пусть следующие этапы и весь горизонт продлений будут видны целиком.
    ...block(
      `Следующие этапы (${money.nextStages.length})`,
      money.nextStages.map(billLine),
    ),
    ...block(
      `Скоро продлить (${credentials.later.length})`,
      credentials.later.map(credentialLine),
    ),
  ];

  return fitMessage(["🌅 <b>Что горит</b>", "", ...blocks]);
}

/** Отправляет сводку в общий чат. */
export async function sendTeamDigest(log: Log): Promise<void> {
  if (!env.TELEGRAM_TEAM_CHAT_ID) {
    log.warn({}, "TELEGRAM_TEAM_CHAT_ID не задан — сводку слать некуда");
    return;
  }

  const text = await buildDigest();
  if (!text) return;

  try {
    await sendMessage(env.TELEGRAM_TEAM_CHAT_ID, text);
    log.info({}, "утренняя сводка отправлена в общий чат");
  } catch (cause) {
    // Чат удалён или бота из него выгнали — повторять нечего, но знать надо.
    if (cause instanceof TelegramError && cause.isGone) {
      log.error({ err: cause }, "общий чат недоступен: бот удалён или чат стёрт");
      return;
    }
    log.error({ err: cause }, "не удалось отправить сводку в общий чат");
  }
}
