import { z } from "zod";

/**
 * Общие правила разбора полей форм CRM. Вынесены, потому что лиды, клиенты,
 * проекты и задачи описывают одни и те же типы значений, а разъехавшиеся копии
 * этих трёх строк дали бы разное поведение на разных экранах.
 */

/**
 * Пустая строка из формы означает «поле не заполнено», а не «значение — пустая
 * строка». Без этого в базе копятся `""`, и любой поиск по «есть значение»
 * начинает врать.
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable();

/**
 * Верхний предел суммы в минорных единицах. Колонки сумм — INTEGER, больше в них
 * не помещается: сумма сверх предела дала бы 500 вместо понятного 400.
 */
export const MAX_AMOUNT_MINOR = 2_147_483_647;

/** `null` проверяется первым: z.coerce.date() превратил бы его в 1970 год. */
export const optionalDate = z.union([z.null(), z.coerce.date()]);

export const optionalUuid = z.union([z.null(), z.string().uuid()]);

/** Обязательное название: сущность без имени невозможно найти в списке. */
export const requiredTitle = (max: number, message: string) =>
  z.string().trim().min(1, message).max(max);
