const dayMonth = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const dayMonthTime = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Разница в календарных днях: 0 — сегодня, −1 — вчера, 1 — завтра. */
export function daysFromToday(iso: string): number {
  const target = startOfDay(new Date(iso));
  const today = startOfDay(new Date());
  return Math.round((target - today) / 86_400_000);
}

/**
 * Год показываем, только если он не текущий: «10 авг» читается быстрее, чем
 * «10 авг 2026 г.», а в списке таких дат десятки.
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  const format =
    date.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear;
  return format.format(date);
}

export function formatDateTime(iso: string): string {
  return dayMonthTime.format(new Date(iso));
}

/** Человеческая подпись к сроку: она важнее самой даты. */
export function describeDeadline(iso: string): { label: string; tone: Tone } {
  const days = daysFromToday(iso);
  if (days < 0) {
    const overdue = Math.abs(days);
    return { label: `просрочено на ${overdue} ${pluralDays(overdue)}`, tone: "danger" };
  }
  if (days === 0) return { label: "сегодня", tone: "warning" };
  if (days === 1) return { label: "завтра", tone: "warning" };
  return { label: formatDate(iso), tone: "neutral" };
}

export type Tone = "danger" | "warning" | "neutral";

function pluralDays(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дня";
  return "дней";
}

/** ISO → значение для <input type="date"> в местном часовом поясе. */
export function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Дата из формы → конец этого дня. Иначе «следующий шаг сегодня» становится
 * просроченным уже в 00:01, потому что в базе лежит полночь.
 */
export function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 59).toISOString();
}

/**
 * «2026-08» → «август 2026». Периоды счетов хранятся строкой, а не датой:
 * счёт выставляется за месяц целиком, и день в нём ничего не значит.
 */
export function periodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" })
    .format(new Date(year, month - 1, 1))
    .replace(" г.", "");
}

/** «2026-08» → «август»: год в короткой подписи к текущему месяцу только мешает. */
export function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(
    new Date(year, month - 1, 1),
  );
}

/**
 * Следующий срок продления после оплаты — для кнопки «Оплатил» в доступах.
 *
 * Отдельной отметки «оплачено» у записи нет и не нужно: оплата домена или
 * подписки означает ровно одно — срок сдвинулся вперёд. Хранить рядом с датой
 * ещё и флаг значит завести два источника одной правды, которые разойдутся при
 * первой же правке даты руками.
 *
 * Период всегда календарный месяц — независимо от того, помесячная это плата
 * или разовая. Кнопка закрывает частый случай, а не все: у годовых продлений
 * дата всё равно своя, и её правят в карточке руками.
 *
 * Считаем от текущего срока, но не раньше сегодняшнего дня: запись, забытая на
 * два года, иначе продлилась бы в прошлое — то есть осталась бы просроченной
 * сразу после нажатия.
 *
 * День прижимается к последнему числу месяца: 31 января плюс месяц — это 28 или
 * 29 февраля, а не 3 марта, как посчитал бы `setMonth` сам по себе.
 */
export function nextRenewalDate(current: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [year, month, day] = current.split("-").map(Number);
  const parsed = year && month && day ? new Date(year, month - 1, day) : null;
  const base = parsed && parsed > today ? parsed : today;

  const targetMonth = base.getMonth() + 1;
  const lastDay = new Date(base.getFullYear(), targetMonth + 1, 0).getDate();
  const next = new Date(
    base.getFullYear(),
    targetMonth,
    Math.min(base.getDate(), lastDay),
  );

  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${next.getFullYear()}-${mm}-${dd}`;
}
