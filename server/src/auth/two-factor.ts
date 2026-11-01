import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { audit } from "../audit.js";
import { canVault, open, seal } from "../crypto/sealed.js";
import { prisma } from "../db.js";
import { canNotify, env } from "../env.js";
import { escapeHtml, trySendMessage } from "../notify/telegram.js";
import { requireAuth } from "./guard.js";
import { verifyPassword } from "./password.js";
import { createSession, hashToken, toUserDto } from "./session.js";
import {
  base32Decode,
  base32Encode,
  generateSecret,
  matchStep,
  otpauthUri,
} from "./totp.js";

/**
 * Двухфакторный вход (TOTP) и то, что на нём держится: билет между паролем и кодом,
 * окно подтверждения для просмотра паролей, коды восстановления.
 *
 * 2FA не принудительная, чтобы никого не запереть, но без неё пароли не открываются.
 * Вход общий с панелью сайта, поэтому второй шаг обязан работать и там.
 *
 * В лог отсюда не попадают `password`, `code`, `ticket`, `recoveryCodes`, `secret`,
 * `otpauthUri` и `qrSvg`; у неудачи только `userId`. Тело запроса Fastify сам не
 * логирует, а адрес логирует, поэтому в query секретов нет.
 */

const TICKET_TTL_MS = 5 * 60 * 1000;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_CODES = 5;
const LOCK_MS = 15 * 60 * 1000;
/** Сколько живёт начатое подключение: QR отсканировать успевают, а брошенное гаснет. */
const SETUP_TTL_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 16;
/** Как коды телеграма: без символов, которые путаются при вводе с бумажки. */
const RECOVERY_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";

/** Лимит шагов входа и настройки: всё, что принимает код или пароль. */
const STRICT_LIMIT = { rateLimit: { max: 10, timeWindow: "5 minutes" } };

/**
 * Везде, где принимается только TOTP, код проходит через эту схему до `verifyTotp`:
 * `timingSafeEqual` бросает на другой длине, и кривой код дал бы 500 вместо 400.
 */
export const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Код — шесть цифр");

/** Там, где подходит и код восстановления. */
const anyCode = z.string().trim().min(6).max(64);
const passwordField = z.string().min(1).max(200);

const secondStepBody = z.object({ ticket: z.string().min(1).max(128), code: anyCode });
const setupBody = z.object({ password: passwordField });
const totpBody = z.object({ code: totpCode });
const disableBody = z.object({ password: passwordField, code: anyCode });

export type TotpResult =
  "ok" | "invalid" | "reused" | "locked" | "unavailable" | "not_enabled";

function aadFor(userId: string): string {
  return `totp:${userId}`;
}

/** Ответ с причиной: интерфейс реагирует на `code`, текст показывается человеку. */
function fail(reply: FastifyReply, status: number, code: string, error: string) {
  return reply.code(status).send({ error, code });
}

const sendVaultUnavailable = (reply: FastifyReply) =>
  fail(reply, 503, "vault_unavailable", "На сервере не задан ключ шифрования");
const sendCodeInvalid = (reply: FastifyReply, status: 401 | 403) =>
  fail(reply, status, "code_invalid", "Неверный код");
const sendLocked = (reply: FastifyReply) =>
  fail(reply, 429, "locked", "Слишком много неверных кодов. Подождите 15 минут");
const sendPasswordInvalid = (reply: FastifyReply) =>
  fail(reply, 403, "password_invalid", "Неверный пароль");
const sendTicketExpired = (reply: FastifyReply) =>
  fail(reply, 401, "ticket_expired", "Время на ввод кода вышло. Войдите заново");
const sendTwoFactorRequired = (reply: FastifyReply) =>
  fail(
    reply,
    403,
    "two_factor_required",
    "Сначала включите двухфакторный вход в Настройках",
  );

/**
 * Чтение результата вне входа. На входе своя таблица: там неверный код — это 401, а
 * здесь 401 означает только отсутствие сессии, иначе его не отличить от выхода.
 */
function sendTotpFailure(
  reply: FastifyReply,
  result: Exclude<TotpResult, "ok">,
  notEnabled: "two_factor_required" | "conflict",
) {
  switch (result) {
    case "invalid":
    case "reused":
      return sendCodeInvalid(reply, 403);
    case "locked":
      return sendLocked(reply);
    case "unavailable":
      return sendVaultUnavailable(reply);
    case "not_enabled":
      return notEnabled === "conflict"
        ? reply.code(409).send({ error: "Двухфакторный вход не включён" })
        : sendTwoFactorRequired(reply);
  }
}

/** Секрет вперемешку с ответом: в кэш прокси и браузера такое попасть не должно. */
function noStore(reply: FastifyReply): void {
  void reply.header("Cache-Control", "no-store");
}

/** Отправка в фоне: ответ её не ждёт, а сбой телеграма только логируется. */
function tellTeam(request: FastifyRequest, text: string): void {
  if (!canNotify || !env.TELEGRAM_TEAM_CHAT_ID) return;
  void trySendMessage(env.TELEGRAM_TEAM_CHAT_ID, text, request.log).catch(
    (cause: unknown) => {
      request.log.warn({ err: cause }, "сообщение о блокировке не отправлено");
    },
  );
}

/**
 * Пять неверных кодов значат, что пароль уже знает кто-то чужой, поэтому блокировка
 * видна людям, а не только журналу.
 */
async function reportLock(
  request: FastifyRequest,
  userId: string,
  email: string,
): Promise<void> {
  request.log.warn({ userId }, "2FA заблокирована после неверных кодов");
  await audit(request, {
    entity: "users",
    entityId: userId,
    action: "2fa_locked",
    userId,
  });
  tellTeam(
    request,
    `🔒 Вход заблокирован после ${MAX_FAILED_CODES} неверных кодов: ${escapeHtml(email)}`,
  );
}

/** То же при подключении: чаще всего это опечатки, но так выглядит и подбор по куке. */
async function reportSetupReset(
  request: FastifyRequest,
  userId: string,
  email: string,
): Promise<void> {
  request.log.warn({ userId }, "подключение 2FA сброшено после неверных кодов");
  await audit(request, { entity: "users", entityId: userId, action: "2fa_setup_reset" });
  tellTeam(
    request,
    `🔒 Подключение 2FA сброшено после ${MAX_FAILED_CODES} неверных кодов: ${escapeHtml(email)}`,
  );
}

/**
 * Незавершённое подключение целиком. Секрет стирается, а не просто считается: новый
 * `setup` снова потребует пароль, которого у вора с кукой нет.
 */
const SETUP_CLEARED = {
  totpSecretEnc: null,
  totpSetupAt: null,
  totpLastStep: null,
  totpFailedAttempts: 0,
} as const;

/** Чат, привязанный к учётке, читает `/today` мимо сессий. Код снимается вместе с ним. */
const TELEGRAM_CLEARED = {
  telegramChatId: null,
  telegramLinkCode: null,
  telegramLinkExpiresAt: null,
} as const;

/** Подключение сброшено: код вводить больше не к чему, интерфейс возвращает к паролю. */
const sendSetupReset = (reply: FastifyReply, error: string) =>
  fail(reply, 409, "setup_reset", error);

type EnableResult =
  | { result: "enabled"; telegramChatId: string | null }
  | { result: "invalid" | "not_started" | "expired" | "unavailable" }
  | { result: "reset"; email: string };

const TOTP_FIELDS = {
  email: true,
  totpSecretEnc: true,
  totpEnabledAt: true,
  totpLastStep: true,
  totpFailedAttempts: true,
  totpLockedUntil: true,
} as const;

/**
 * Проверка кода. Вся идёт в одной транзакции под блокировкой строки пользователя:
 * счётчик и блокировка работают, только если чтение и запись не разделены. Иначе
 * сотня одновременных запросов прочитала бы «не заблокирован» и проверила бы сотню
 * кодов вместо пяти.
 */
export async function verifyTotp(
  request: FastifyRequest,
  userId: string,
  code: string,
): Promise<TotpResult> {
  const { result, lockedEmail } = await prisma.$transaction(
    async (tx): Promise<{ result: TotpResult; lockedEmail?: string }> => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: TOTP_FIELDS,
      });

      if (!user?.totpEnabledAt || !user.totpSecretEnc) return { result: "not_enabled" };

      const now = new Date();
      if (user.totpLockedUntil && user.totpLockedUntil > now) return { result: "locked" };

      let secret: Buffer;
      try {
        secret = base32Decode(open(user.totpSecretEnc, aadFor(userId)));
      } catch {
        return { result: "unavailable" };
      }

      const step = matchStep(secret, code, now.getTime());
      if (step !== null) {
        // Свой же код, отправленный дважды: счётчик ошибок он не увеличивает.
        if (user.totpLastStep !== null && step <= user.totpLastStep) {
          return { result: "reused" };
        }
        await tx.user.update({
          where: { id: userId },
          data: { totpLastStep: step, totpFailedAttempts: 0, totpLockedUntil: null },
        });
        return { result: "ok" };
      }

      const failed = user.totpFailedAttempts + 1;
      const lockNow = failed >= MAX_FAILED_CODES;
      await tx.user.update({
        where: { id: userId },
        data: {
          totpFailedAttempts: lockNow ? 0 : failed,
          ...(lockNow && { totpLockedUntil: new Date(now.getTime() + LOCK_MS) }),
        },
      });
      return { result: "invalid", ...(lockNow && { lockedEmail: user.email }) };
    },
  );

  if (lockedEmail) await reportLock(request, userId, lockedEmail);
  if (result !== "ok") request.log.warn({ userId }, "код 2FA не принят");
  return result;
}

function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Гасит код одним запросом: два одновременных входа одним кодом не пройдут оба. */
export async function consumeRecoveryCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const { count } = await prisma.recoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

/** Показываются один раз: в базе остаётся только хэш. */
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let raw = "";
    for (let index = 0; index < RECOVERY_CODE_LENGTH; index += 1) {
      raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    return raw.match(/.{4}/g)!.join("-");
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Билет между паролем и кодом. В ответе сам билет, в базе только его хэш. */
export async function issueLoginTicket(
  userId: string,
  ip: string,
): Promise<{ ticket: string; expiresAt: string }> {
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await prisma.loginTicket.create({
    data: { userId, tokenHash: hashToken(ticket), expiresAt, ip },
  });
  return { ticket, expiresAt: expiresAt.toISOString() };
}

/**
 * Второй фактор для действий внутри сессии: просмотр паролей, их перенос, «Команда».
 *
 * Возвращает `true` либо уже отправил ответ и возвращает `false`. Окно живёт в строке
 * сессии, поэтому выход гасит его сам, а просмотры его не продлевают. Принимается
 * только TOTP: окно на десять минут не должно открываться одноразовым кодом
 * восстановления.
 */
export async function confirmSecondFactor(
  request: FastifyRequest,
  reply: FastifyReply,
  code?: string,
): Promise<boolean> {
  const user = request.user!;
  const session = request.authSession!;

  if (!canVault) {
    await sendVaultUnavailable(reply);
    return false;
  }
  if (!user.totpEnabledAt) {
    await sendTwoFactorRequired(reply);
    return false;
  }

  const until = session.twoFactorConfirmedUntil;
  if (until && until > new Date()) return true;

  if (!code) {
    await fail(reply, 403, "code_required", "Введите код из приложения");
    return false;
  }

  const result = await verifyTotp(request, user.id, code);
  if (result !== "ok") {
    await sendTotpFailure(reply, result, "two_factor_required");
    return false;
  }

  const confirmedUntil = new Date(Date.now() + CONFIRM_WINDOW_MS);
  await prisma.session.update({
    where: { id: session.id },
    data: { twoFactorConfirmedUntil: confirmedUntil },
  });
  session.twoFactorConfirmedUntil = confirmedUntil;
  return true;
}

/**
 * Подтверждение владельца для «Команды». Без него украденная кука заводит учётку с
 * известным паролем, подключает на ней свою 2FA и открывает все пароли, хотя `setup` и
 * `reveal` самого владельца для неё закрыты. Без 2FA хватает пароля: она не принудительная.
 */
export async function confirmOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  confirm: { password: string; code?: string },
): Promise<boolean> {
  const owner = await prisma.user.findUnique({
    where: { id: request.user!.id },
    select: { passwordHash: true, totpEnabledAt: true },
  });

  if (!owner || !(await verifyPassword(owner.passwordHash, confirm.password))) {
    await sendPasswordInvalid(reply);
    return false;
  }
  if (!owner.totpEnabledAt) return true;
  return confirmSecondFactor(request, reply, confirm.code);
}

export async function twoFactorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Второй шаг входа. Неверный код билет не сжигает: иначе опечатка возвращала бы к
   * паролю, а пароль не доказывает ничего нового. Коды восстановления работают и без
   * `VAULT_KEY`, и при блокировке TOTP: знающий пароль иначе запирал бы человека снова
   * и снова, а подбору они не поддаются (25^16 вариантов).
   */
  app.post("/auth/login/2fa", { config: STRICT_LIMIT }, async (request, reply) => {
    const parsed = secondStepBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Введите код" });
    }

    const { ticket, code } = parsed.data;
    const row = await prisma.loginTicket.findUnique({
      where: { tokenHash: hashToken(ticket) },
      include: { user: true },
    });

    const now = new Date();
    if (!row || row.usedAt || row.expiresAt <= now || row.user.disabledAt) {
      return sendTicketExpired(reply);
    }

    // Билет пережил снятие 2FA: сессию он не даёт, вход только заново.
    const { user } = row;
    if (!user.totpEnabledAt) {
      await prisma.loginTicket.deleteMany({ where: { id: row.id } });
      return sendTicketExpired(reply);
    }

    let viaTotp = false;

    if (/^\d{6}$/.test(code)) {
      const result = await verifyTotp(request, user.id, code);
      switch (result) {
        case "ok":
          viaTotp = true;
          break;
        case "invalid":
        case "reused":
          return sendCodeInvalid(reply, 401);
        case "locked":
          return sendLocked(reply);
        case "unavailable":
          return sendVaultUnavailable(reply);
        case "not_enabled":
          // 2FA сняли, пока шла проверка: та же ситуация, что и выше.
          await prisma.loginTicket.deleteMany({ where: { id: row.id } });
          return sendTicketExpired(reply);
      }
    } else if (!(await consumeRecoveryCode(user.id, code))) {
      request.log.warn({ userId: user.id }, "код восстановления не принят");
      return sendCodeInvalid(reply, 401);
    }

    // Срок проверяется и здесь: билет мог истечь, пока шла проверка кода.
    const { count } = await prisma.loginTicket.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (count !== 1) return sendTicketExpired(reply);

    // Вход по TOTP сразу открывает окно: код только что введён. Код восстановления
    // окна не открывает: человек без телефона пароли смотреть не должен.
    await createSession(
      reply,
      user,
      request,
      viaTotp ? new Date(Date.now() + CONFIRM_WINDOW_MS) : undefined,
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    await prisma.loginTicket.deleteMany({ where: { userId: user.id } });

    if (!viaTotp) {
      const left = await prisma.recoveryCode.count({
        where: { userId: user.id, usedAt: null },
      });
      await audit(request, {
        entity: "users",
        entityId: user.id,
        action: "2fa_recovery_login",
        diff: { left },
        userId: user.id,
      });
    }

    return reply.send({ user: toUserDto(user) });
  });

  app.get("/auth/2fa/status", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!;
    const recoveryCodesLeft = await prisma.recoveryCode.count({
      where: { userId: user.id, usedAt: null },
    });
    return reply.send({
      available: canVault,
      enabled: user.totpEnabledAt !== null,
      enabledAt: user.totpEnabledAt?.toISOString() ?? null,
      recoveryCodesLeft,
    });
  });

  /**
   * Начать подключение. Требует пароль: иначе украденная сессия подключит свой телефон
   * и откроет все пароли. Повторный вызов до подтверждения заменяет незавершённый секрет.
   */
  app.post(
    "/auth/2fa/setup",
    { preHandler: requireAuth, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = setupBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Введите пароль" });
      if (!canVault) return sendVaultUnavailable(reply);

      const userId = request.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, passwordHash: true, totpEnabledAt: true },
      });
      if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
        return sendPasswordInvalid(reply);
      }
      if (user.totpEnabledAt) {
        return reply.code(409).send({ error: "Двухфакторный вход уже включён" });
      }

      const secret = base32Encode(generateSecret());
      await prisma.user.update({
        where: { id: userId },
        data: {
          totpSecretEnc: seal(secret, aadFor(userId)),
          totpSetupAt: new Date(),
          totpLastStep: null,
          totpFailedAttempts: 0,
          totpLockedUntil: null,
        },
      });

      const uri = otpauthUri(secret, user.email);
      const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1 });

      noStore(reply);
      return reply.send({ secret, otpauthUri: uri, qrSvg });
    },
  );

  /**
   * Подтвердить подключение первым кодом. Пароля здесь нет, поэтому код проверяется
   * той же транзакцией под блокировкой строки, что и при входе, со своим счётчиком:
   * иначе брошенное подключение оставляло бы украденной куке перебор без лимита на
   * человека. Пятая ошибка и истёкший срок стирают секрет: дальше нужен пароль.
   *
   * Блокировка заодно не даёт двойной отправке выпустить два набора кодов. Остальные
   * сессии отзываются, потому что они вошли без второго фактора. Привязка телеграма
   * снимается по той же причине: чат читает сводку мимо сессий.
   */
  app.post(
    "/auth/2fa/enable",
    { preHandler: requireAuth, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = totpBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Код — шесть цифр" });
      if (!canVault) return sendVaultUnavailable(reply);

      const userId = request.user!.id;
      const session = request.authSession!;
      const { codes, hashes } = generateRecoveryCodes();

      const outcome = await prisma.$transaction(async (tx): Promise<EnableResult> => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: {
            email: true,
            telegramChatId: true,
            totpSecretEnc: true,
            totpEnabledAt: true,
            totpSetupAt: true,
            totpFailedAttempts: true,
          },
        });
        if (!user?.totpSecretEnc || user.totpEnabledAt) return { result: "not_started" };

        const now = new Date();
        const startedAt = user.totpSetupAt?.getTime() ?? 0;
        if (now.getTime() - startedAt >= SETUP_TTL_MS) {
          await tx.user.update({ where: { id: userId }, data: SETUP_CLEARED });
          return { result: "expired" };
        }

        let secret: Buffer;
        try {
          secret = base32Decode(open(user.totpSecretEnc, aadFor(userId)));
        } catch {
          return { result: "unavailable" };
        }

        const step = matchStep(secret, parsed.data.code, now.getTime());
        if (step === null) {
          const failed = user.totpFailedAttempts + 1;
          if (failed >= MAX_FAILED_CODES) {
            await tx.user.update({ where: { id: userId }, data: SETUP_CLEARED });
            return { result: "reset", email: user.email };
          }
          await tx.user.update({
            where: { id: userId },
            data: { totpFailedAttempts: failed },
          });
          return { result: "invalid" };
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            totpEnabledAt: now,
            totpLastStep: step,
            totpSetupAt: null,
            totpFailedAttempts: 0,
            ...TELEGRAM_CLEARED,
          },
        });
        await tx.recoveryCode.deleteMany({ where: { userId } });
        await tx.recoveryCode.createMany({
          data: hashes.map((codeHash) => ({ userId, codeHash })),
        });
        await tx.session.update({
          where: { id: session.id },
          data: {
            twoFactorConfirmedUntil: new Date(now.getTime() + CONFIRM_WINDOW_MS),
          },
        });
        await tx.session.updateMany({
          where: { userId, revokedAt: null, id: { not: session.id } },
          data: { revokedAt: now },
        });
        return { result: "enabled", telegramChatId: user.telegramChatId };
      });

      switch (outcome.result) {
        case "enabled":
          await audit(request, {
            entity: "users",
            entityId: userId,
            action: "2fa_enable",
          });
          if (outcome.telegramChatId) {
            await audit(request, {
              entity: "users",
              entityId: userId,
              action: "telegram_unlink",
              diff: { reason: "2fa_enable" },
            });
          }
          noStore(reply);
          return reply.send({ recoveryCodes: codes });
        case "invalid":
          request.log.warn({ userId }, "код подключения 2FA не принят");
          return sendCodeInvalid(reply, 403);
        case "unavailable":
          return sendVaultUnavailable(reply);
        case "reset":
          await reportSetupReset(request, userId, outcome.email);
          return sendSetupReset(
            reply,
            "Слишком много неверных кодов. Начните подключение заново",
          );
        case "expired":
          return sendSetupReset(reply, "Время на подключение вышло. Начните заново");
        case "not_started":
          return sendSetupReset(reply, "Подключение не начато");
      }
    },
  );

  /**
   * Отказ от подключения. Секрет стирается сразу, а не ждёт срока, поэтому пароль здесь
   * не нужен: вернуть секрет можно только через `setup`, а там он нужен.
   */
  app.post("/auth/2fa/cancel", { preHandler: requireAuth }, async (request, reply) => {
    await prisma.user.updateMany({
      where: { id: request.user!.id, totpEnabledAt: null },
      data: SETUP_CLEARED,
    });
    return reply.code(204).send();
  });

  /**
   * Новый набор кодов. Только TOTP, окно его не заменяет: иначе минутная кража сессии
   * давала бы постоянный вход. Старые удаляются и новые создаются в одной транзакции:
   * сбой посередине оставил бы человека без кодов.
   */
  app.post(
    "/auth/2fa/recovery-codes",
    { preHandler: requireAuth, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = totpBody.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "Код — шесть цифр" });

      const userId = request.user!.id;
      const result = await verifyTotp(request, userId, parsed.data.code);
      if (result !== "ok") return sendTotpFailure(reply, result, "conflict");

      const { codes, hashes } = generateRecoveryCodes();
      await prisma.$transaction([
        prisma.recoveryCode.deleteMany({ where: { userId } }),
        prisma.recoveryCode.createMany({
          data: hashes.map((codeHash) => ({ userId, codeHash })),
        }),
      ]);

      await audit(request, {
        entity: "users",
        entityId: userId,
        action: "2fa_recovery_regenerate",
      });

      noStore(reply);
      return reply.send({ recoveryCodes: codes });
    },
  );

  /**
   * Снять 2FA. Принимает и код восстановления: иначе потеря телефона заперла бы
   * человека. Сначала проверяется пароль, потом код: неверный пароль не должен сжигать
   * код восстановления. Окно подтверждения код не заменяет.
   */
  app.post(
    "/auth/2fa/disable",
    { preHandler: requireAuth, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = disableBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Введите пароль и код" });
      }

      const userId = request.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, totpEnabledAt: true },
      });
      if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) {
        return sendPasswordInvalid(reply);
      }
      if (!user.totpEnabledAt) {
        return reply.code(409).send({ error: "Двухфакторный вход не включён" });
      }

      const { code } = parsed.data;
      if (/^\d{6}$/.test(code)) {
        const result = await verifyTotp(request, userId, code);
        if (result !== "ok") return sendTotpFailure(reply, result, "conflict");
      } else if (!(await consumeRecoveryCode(userId, code))) {
        return sendCodeInvalid(reply, 403);
      }

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            ...SETUP_CLEARED,
            totpEnabledAt: null,
            totpLockedUntil: null,
          },
        }),
        prisma.recoveryCode.deleteMany({ where: { userId } }),
        prisma.loginTicket.deleteMany({ where: { userId } }),
        prisma.session.updateMany({
          where: { userId },
          data: { twoFactorConfirmedUntil: null },
        }),
      ]);

      await audit(request, { entity: "users", entityId: userId, action: "2fa_disable" });
      return reply.code(204).send();
    },
  );
}
