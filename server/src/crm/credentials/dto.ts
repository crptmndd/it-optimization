import type { Credential, Currency, Project } from "@prisma/client";

/**
 * Форма учётки для клиента. Вынесена из routes.ts, потому что её читает ещё и
 * экран «Сегодня»: сроки продления попадают в общую сводку, и две копии
 * преобразования разошлись бы при первом же новом поле.
 *
 * Паролей в этой форме нет — их нет и в таблице, см. `routes.ts`.
 */
/**
 * Проект отдаётся вместе с названием, а не одним идентификатором: экран
 * группирует записи по проектам, и без названия ему пришлось бы тянуть весь
 * список проектов ради подписи к заголовку.
 */
export type CredentialWithProject = Credential & {
  project: Pick<Project, "id" | "title"> | null;
};

export interface CredentialDto {
  id: string;
  service: string;
  login: string | null;
  url: string | null;
  owner: string | null;
  project: { id: string; title: string } | null;
  /** Шифротекст пароля. Сервер его не понимает — расшифровка в браузере. */
  secret: string | null;
  renewsAt: string | null;
  amountMinor: number | null;
  currency: Currency;
  monthlyFee: boolean;
  notes: string | null;
}

export function toCredentialDto(item: CredentialWithProject): CredentialDto {
  return {
    id: item.id,
    service: item.service,
    login: item.login,
    url: item.url,
    owner: item.owner,
    project: item.project,
    secret: item.secret,
    renewsAt: item.renewsAt?.toISOString() ?? null,
    amountMinor: item.amountMinor,
    currency: item.currency,
    monthlyFee: item.monthlyFee,
    notes: item.notes,
  };
}
