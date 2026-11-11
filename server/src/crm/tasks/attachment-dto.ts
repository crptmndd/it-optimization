import type { TaskAttachment } from "@prisma/client";

/**
 * Вложение для ответа API. Отдельно от `attachments.ts`, потому что его зовёт `dto.ts`, а
 * `attachments.ts` сам стоит на `service.ts` и через него на `dto.ts`: без этого файла
 * модули ссылались бы друг на друга по кругу.
 */

/**
 * Что браузер покажет прямо во вкладке. Остальное только скачивается: SVG или HTML,
 * открытые с адреса API, исполнили бы свой код от его имени, а там живёт сессия.
 */
export const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

export interface AttachmentDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Путь в API, к нему приписывается адрес сервера. */
  url: string;
  /** Картинка, которую можно показать миниатюрой. */
  image: boolean;
}

export function toAttachmentDto(row: TaskAttachment): AttachmentDto {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    url: `/tasks/${row.taskId}/attachments/${row.id}`,
    image: INLINE_TYPES.has(row.mimeType) && row.mimeType.startsWith("image/"),
  };
}
