import { buildDigest, sendMorningDigest } from "../notify/digest.js";
import { prisma } from "../db.js";

/**
 * Показывает утреннюю сводку, ничего не отправляя.
 *
 *   npm run digest:preview          — напечатать в терминал
 *   npm run digest:preview -- send  — отправить в общий чат прямо сейчас
 *
 * Проверять текст, рассылая его в рабочий чат, — плохая идея: формулировки
 * правятся часто, а команда получает их все.
 */
function strip(html: string): string {
  // Телеграм рисует разметку сам; в терминале она только мешает читать.
  return html
    .replace(/<\/?(b|i|code)>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function main(): Promise<void> {
  if (process.argv.includes("send")) {
    await sendMorningDigest({
      info: (_obj, msg) => console.log(msg),
      warn: (_obj, msg) => console.warn(msg),
      error: (obj, msg) => console.error(msg, obj),
    });
    return;
  }

  const digest = await buildDigest();
  console.log(digest ? strip(digest) : "Ничего не горит — бот промолчал бы.");
}

main()
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
