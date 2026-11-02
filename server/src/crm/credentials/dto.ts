import type { Credential, Currency, Prisma, Project } from "@prisma/client";

/**
 * Форма учётки для клиента. Вынесена из routes.ts, потому что её читает ещё и
 * экран «Сегодня»: сроки продления попадают в общую сводку, и две копии
 * преобразования разошлись бы при первом же новом поле.
 *
 * Паролей в этой форме нет ни в каком виде, даже шифротекста: их отдаёт только
 * `POST /credentials/:id/reveal`, с кодом 2FA и записью в журнал.
 */
/**
 * Проект отдаётся вместе с названием, а не одним идентификатором: экран
 * группирует записи по проектам, и без названия ему пришлось бы тянуть весь
 * список проектов ради подписи к заголовку.
 */
export type CredentialWithProject = Credential & {
  project: Pick<Project, "id" | "title"> | null;
  /** Отметка того, кто спрашивает. Без неё, как на экране «Сегодня», запись не закреплена. */
  pins?: { createdAt: Date }[];
};

/**
 * Старый пароль, судьба которого ещё не решена: мастер-фразой зашифрован, сюда не
 * перенесён и не заменён новым. Одно условие на кнопку, выборку и перенос. Удалённые
 * записи не входят: живым они не нужны, а отдавать их незачем.
 */
export const LEGACY_PENDING = {
  deletedAt: null,
  passwordEnc: null,
  secretMigratedAt: null,
  secret: { not: null },
} satisfies Prisma.CredentialWhereInput;

export interface CredentialDto {
  id: string;
  service: string;
  login: string | null;
  url: string | null;
  owner: string | null;
  project: { id: string; title: string } | null;
  /** Пароль сохранён и открывается через reveal. */
  hasPassword: boolean;
  /** Есть старый пароль, который надо перенести: см. `LEGACY_PENDING`. */
  legacyPending: boolean;
  renewsAt: string | null;
  amountMinor: number | null;
  currency: Currency;
  monthlyFee: boolean;
  notes: string | null;
  /** Когда запись закрепил тот, кто спрашивает. */
  pinnedAt: string | null;
}

export function isLegacyPending(
  item: Pick<Credential, "secret" | "secretMigratedAt" | "passwordEnc">,
): boolean {
  return (
    item.secret !== null && item.secretMigratedAt === null && item.passwordEnc === null
  );
}

export function toCredentialDto(item: CredentialWithProject): CredentialDto {
  return {
    id: item.id,
    service: item.service,
    login: item.login,
    url: item.url,
    owner: item.owner,
    project: item.project,
    hasPassword: item.passwordEnc !== null,
    legacyPending: isLegacyPending(item),
    renewsAt: item.renewsAt?.toISOString() ?? null,
    amountMinor: item.amountMinor,
    currency: item.currency,
    monthlyFee: item.monthlyFee,
    notes: item.notes,
    pinnedAt: item.pins?.[0]?.createdAt.toISOString() ?? null,
  };
}
