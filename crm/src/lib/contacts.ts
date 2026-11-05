/**
 * Ссылка, по которой контакт открывается одним нажатием: звонок, письмо, чат.
 *
 * Значения вписаны руками и как попало («@ivan», «t.me/ivan», «+7 (999) 123-45-67»),
 * поэтому разбор терпимый. Не узнали — ссылки нет, и контакт остаётся текстом: лучше
 * не открыть ничего, чем открыть чужой чат.
 */
export function contactHref(type: string, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  const digits = value.replace(/[^\d+]/g, "");
  const isPhone = /^\+?\d{6,15}$/.test(digits) && !/[a-z@]/i.test(value);

  switch (type) {
    case "phone":
      return isPhone ? `tel:${digits}` : null;
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? `mailto:${value}` : null;
    case "telegram": {
      // Номер телефона Телеграм открывает по t.me/+79991234567.
      if (isPhone)
        return `https://t.me/${digits.startsWith("+") ? digits : `+${digits}`}`;
      const handle = value
        .replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, "")
        .replace(/^@/, "");
      return /^[a-z0-9_]{4,32}$/i.test(handle) ? `https://t.me/${handle}` : null;
    }
    case "whatsapp":
      return isPhone ? `https://wa.me/${digits.replace(/^\+/, "")}` : null;
    default:
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `mailto:${value}`;
      return isPhone ? `tel:${digits}` : null;
  }
}
