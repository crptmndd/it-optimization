import { readFile } from "node:fs/promises";
import type { TaskAttachment } from "@prisma/client";
import { attachmentPath } from "../crm/tasks/attachments.js";
import { prisma } from "../db.js";
import {
  escapeHtml,
  postMessage,
  sendMedia,
  TelegramError,
  type OutgoingMedia,
} from "./telegram.js";

/**
 * «🗂 Файлы» под задачей: бот присылает её скриншоты и документы в чат. Без этого файлы,
 * приложенные к задаче, были видны только в CRM, а в телеграме — одна строка «📎 Файлов:
 * 3», и за скриншотом бага приходилось идти в браузер.
 *
 * Картинки и видео уходят альбомами, чтобы их листать, а не открывать по одному;
 * остальное — документами. Телеграм принимает в альбоме до десяти файлов, а картинку как
 * фото — только до 10 МБ и разумных пропорций: что он отверг как фото, уходит документом.
 */

interface Log {
  warn: (obj: unknown, msg: string) => void;
}

const ALBUM = 10;
/** Сколько везти одним запросом: альбом из десяти видео целиком лёг бы в память. */
const BATCH_BYTES = 30 * 1024 * 1024;
const PHOTO_BYTES = 10 * 1024 * 1024;
/** Больше ботам загружать нельзя вовсе. */
const DOCUMENT_BYTES = 50 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function kindOf(row: TaskAttachment): OutgoingMedia["kind"] {
  if (PHOTO_TYPES.has(row.mimeType) && row.size <= PHOTO_BYTES) return "photo";
  if (row.mimeType === "video/mp4") return "video";
  return "document";
}

/** Куски не длиннее альбома и не тяжелее `BATCH_BYTES`, порядок сохраняется. */
function batches(rows: TaskAttachment[]): TaskAttachment[][] {
  const out: TaskAttachment[][] = [];
  let current: TaskAttachment[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (
      current.length >= ALBUM ||
      (current.length > 0 && bytes + row.size > BATCH_BYTES)
    ) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += row.size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function load(
  rows: TaskAttachment[],
  kind: (row: TaskAttachment) => OutgoingMedia["kind"],
  failed: string[],
): Promise<{ row: TaskAttachment; item: OutgoingMedia }[]> {
  const loaded: { row: TaskAttachment; item: OutgoingMedia }[] = [];
  for (const row of rows) {
    try {
      const bytes = await readFile(attachmentPath(row.storageKey));
      loaded.push({
        row,
        item: { kind: kind(row), name: row.fileName, mime: row.mimeType, bytes },
      });
    } catch {
      // Файла нет на диске: запись осталась, а сам он потерян или не доехал из бэкапа.
      failed.push(row.fileName);
    }
  }
  return loaded;
}

/**
 * Прислать файлы задачи в чат. Сбой одного куска не останавливает остальные: картинки,
 * которые телеграм не принял как фото, уходят документами, а что не ушло и так, —
 * списком в конце.
 */
export async function sendTaskFiles(
  input: { taskId: string; title: string; chatId: string; replyTo?: number },
  log: Log,
): Promise<{ sent: number; failed: string[] }> {
  const rows = await prisma.taskAttachment.findMany({
    where: { taskId: input.taskId },
    orderBy: { createdAt: "asc" },
  });
  const failed: string[] = [];
  const fits = rows.filter((row) => {
    if (row.size <= DOCUMENT_BYTES) return true;
    failed.push(row.fileName);
    return false;
  });
  const visual = fits.filter((row) => kindOf(row) !== "document");
  const documents = fits.filter((row) => kindOf(row) === "document");

  let caption: string | undefined =
    `📎 <b>${escapeHtml(input.title)}</b> · файлов: ${rows.length}`;
  let sent = 0;
  const deliver = async (items: OutgoingMedia[]) => {
    await sendMedia(input.chatId, items, { caption, replyTo: input.replyTo });
    caption = undefined;
    sent += items.length;
  };

  for (const batch of batches(visual)) {
    const loaded = await load(batch, kindOf, failed);
    if (loaded.length === 0) continue;
    try {
      await deliver(loaded.map(({ item }) => item));
    } catch (cause) {
      if (!(cause instanceof TelegramError)) throw cause;
      // Слишком вытянутый скриншот или формат, который телеграм не показывает как фото.
      log.warn({ err: cause }, "альбом не принят, отправляю документами");
      documents.push(...loaded.map(({ row }) => row));
    }
  }

  for (const batch of batches(documents)) {
    const items = (await load(batch, () => "document", failed)).map(({ item }) => item);
    if (items.length === 0) continue;
    try {
      await deliver(items);
    } catch (cause) {
      if (!(cause instanceof TelegramError)) throw cause;
      // Один плохой файл не должен топить весь альбом: по одному.
      for (const item of items) {
        try {
          await deliver([item]);
        } catch (single) {
          log.warn({ err: single }, "файл задачи не отправлен в телеграм");
          failed.push(item.name);
        }
      }
    }
  }

  if (failed.length > 0) {
    await postMessage(
      input.chatId,
      `⚠️ Не отправились: ${failed.map((name) => `«${escapeHtml(name)}»`).join(", ")}. Они есть в карточке задачи в CRM.`,
    ).catch((cause: unknown) =>
      log.warn({ err: cause }, "список неотправленных не ушёл"),
    );
  }
  return { sent, failed };
}
