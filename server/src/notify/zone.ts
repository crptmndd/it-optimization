/**
 * Работа с календарными сутками в часовом поясе команды.
 *
 * Сервер живёт в UTC, а «просрочено» и «сегодня» люди считают по своему
 * времени: лид со сроком «сегодня» не должен становиться просроченным в три
 * часа ночи по Москве только потому, что в Лондоне уже наступило завтра.
 * Библиотеки вроде date-fns-tz ради трёх функций брать не стали — Intl умеет
 * всё нужное с 2020 года.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function partsOf(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // hourCycle вместо hour12: false — иначе полночь местами приходит как «24».
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Тип указан явно: иначе ключом Map становится узкий литеральный тип частей
  // формата, и обычная строка в get() уже не подходит.
  const parts = new Map<string, string>(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const read = (key: string) => Number(parts.get(key) ?? "0");

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

/** Смещение пояса от UTC для конкретного момента, в миллисекундах. */
function offsetMs(date: Date, timeZone: string): number {
  const parts = partsOf(date, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    date.getUTCSeconds(),
  );
  return asIfUtc - date.getTime();
}

/** Текущие время (ЧЧ:ММ) и календарная дата (ГГГГ-ММ-ДД) в поясе. */
export function zonedNow(timeZone: string, now = new Date()): { date: string; time: string } {
  const { year, month, day, hour, minute } = partsOf(now, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
  };
}

/** Момент начала сегодняшних суток в поясе, выраженный в абсолютном времени. */
export function startOfToday(timeZone: string, now = new Date()): Date {
  const { year, month, day } = partsOf(now, timeZone);
  const midnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Полночь «как будто в UTC» сдвигаем на смещение пояса в этот же момент.
  return new Date(midnightAsUtc - offsetMs(new Date(midnightAsUtc), timeZone));
}

/** Начало завтрашних суток — верхняя граница выборки «на сегодня». */
export function startOfTomorrow(timeZone: string, now = new Date()): Date {
  const today = startOfToday(timeZone, now);
  // Сутки прибавляем через календарь, а не 24 часами: при переходе на летнее
  // время сутки бывают короче или длиннее.
  return startOfToday(timeZone, new Date(today.getTime() + 36 * 60 * 60 * 1000));
}

/** Сколько полных суток прошло с даты до начала сегодняшнего дня. */
export function daysOverdue(deadline: Date, timeZone: string, now = new Date()): number {
  const start = startOfToday(timeZone, now).getTime();
  const target = startOfToday(timeZone, deadline).getTime();
  return Math.max(0, Math.round((start - target) / (24 * 60 * 60 * 1000)));
}

/** Сколько полных суток осталось до даты. Уже наступившая — 0. */
export function daysUntil(deadline: Date, timeZone: string, now = new Date()): number {
  const start = startOfToday(timeZone, now).getTime();
  const target = startOfToday(timeZone, deadline).getTime();
  return Math.max(0, Math.round((target - start) / (24 * 60 * 60 * 1000)));
}

/**
 * «2026-11» → «ноябрь 2026». Месяц собирается из частей строки и форматируется в
 * UTC: период — календарный месяц, и `new Date("2026-11-01")` в поясе с
 * отрицательным смещением дал бы октябрь.
 */
export function periodTitle(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
    .format(new Date(Date.UTC(year, month - 1, 1)))
    .replace(/\s*г\.$/, "");
}

/**
 * «12 нояб.» — день в поясе команды. Срок задачи хранится моментом, конец дня по
 * часам браузера, и в UTC он уже бывает следующими сутками.
 */
export function formatDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    timeZone,
  }).format(date);
}

/** «3 дня», «1 день» — русские окончания, без которых текст выглядит машинным. */
export function pluralDays(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${count} дней`;
  if (mod10 === 1) return `${count} день`;
  if (mod10 >= 2 && mod10 <= 4) return `${count} дня`;
  return `${count} дней`;
}
