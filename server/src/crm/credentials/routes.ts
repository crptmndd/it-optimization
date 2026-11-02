import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { requireCrmOrigin, requireAdmin } from "../../auth/guard.js";
import { confirmSecondFactor, totpCode } from "../../auth/two-factor.js";
import { canVault, open, seal } from "../../crypto/sealed.js";
import { prisma } from "../../db.js";
import {
  MAX_AMOUNT_MINOR,
  optionalDate,
  optionalText,
  optionalUuid,
  requiredTitle,
} from "../fields.js";
import { invalidInput } from "../http.js";
import { isLegacyPending, LEGACY_PENDING, toCredentialDto as toDto } from "./dto.js";

/** Название проекта нужно экрану для заголовка группы — тянем сразу. */
const PROJECT_BRIEF = { project: { select: { id: true, title: true } } } as const;

/**
 * Справочник учёток сервисов: что есть, на кого записано, когда продлевать и
 * под каким паролем заходят.
 *
 * Пароли шифрует сервер (AES-256-GCM, ключ `VAULT_KEY` из окружения). Запрет на
 * серверную расшифровку отменён владельцем: пароль должен открываться кодом 2FA, без
 * мастер-фразы. База по-прежнему уезжает в ночные дампы, но ключа в них нет, и утечка
 * дампа не отдаёт сервисы.
 *
 * Отсюда правила, которые легко нарушить по невнимательности: списки и карточки
 * пароля не отдают никогда, значение не попадает ни в лог, ни в журнал, а открыть его
 * можно только через `reveal`, со вторым фактором и строкой в `audit_log`.
 *
 * Колонка `secret` заморожена: туда не пишет никто, она читается только при разовом
 * переносе и остаётся запасом на случай отката API.
 */

/** Просмотр паролей — по одному, поэтому лимит мягче, чем на вход. */
const REVEAL_LIMIT = { rateLimit: { max: 60, timeWindow: "5 minutes" } };
/** Чтение и перенос всех старых паролей разом: действие разовое. */
const MIGRATE_LIMIT = { rateLimit: { max: 10, timeWindow: "5 minutes" } };
/** Столько записей браузер расшифровывает за один проход. Остальные — следующим. */
const MIGRATE_BATCH = 500;

const REVEAL_GUARDS = [requireAdmin, requireCrmOrigin];

const idParams = z.object({ id: z.string().uuid() });

const credentialFields = {
  service: requiredTitle(120, "Без названия сервиса запись бесполезна"),
  login: optionalText(200),
  url: optionalText(300),
  owner: optionalText(120),
  projectId: optionalUuid,
  // Открытым текстом, по HTTPS: шифрует сервер. Не тримится, пробелы в пароле значимы.
  // null стирает пароль, отсутствие поля его не трогает.
  password: z.string().min(1).max(500).nullable(),
  // Старая вкладка CRM присылает новый пароль шифротекстом сюда. Молча отбросить его
  // нельзя: ответ был бы 200, а пароль потерялся. Строка получает 409, null
  // игнорируется. Удалить следующим релизом, вместе с остальной совместимостью.
  secret: z.union([z.null(), z.string().max(4096)]),
  renewsAt: optionalDate,
  // Рубли целыми, как у проекта: копеек в абонплате не бывает.
  // Минорные единицы: сто миллионов копеек — это миллион рублей.
  amountMinor: z.union([z.null(), z.number().int().min(0).max(MAX_AMOUNT_MINOR)]),
  monthlyFee: z.boolean(),
  currency: z.enum(["rub", "usd"]),
  // 2000 своих символов плюс бывшее «Где пароль» (200) с подписью: миграция
  // дописала его в заметки, и такая запись должна сохраняться из формы.
  notes: optionalText(2400),
};

const createBody = z.object(credentialFields).partial().required({ service: true });
const updateBody = z.object(credentialFields).partial();
const listQuery = z.object({ search: z.string().trim().max(200).optional() });

const codeBody = z.object({ code: totpCode.optional() });
const migrateBody = z.object({
  items: z
    .array(z.object({ id: z.string().uuid(), password: z.string().min(1).max(500) }))
    .max(MIGRATE_BATCH),
  code: totpCode.optional(),
});

function sendClientOutdated(reply: FastifyReply) {
  return reply.code(409).send({
    error: "CRM обновляется, пароль не сохранён. Обновите страницу чуть позже",
    code: "client_outdated",
  });
}

function sendNoVaultKey(reply: FastifyReply) {
  return reply.code(503).send({
    error: "На сервере не задан ключ шифрования, пароль не сохранён",
    code: "vault_unavailable",
  });
}

/** Что записать в базу по полю `password`. Поля нет — пароль не меняется. */
function passwordChange(id: string, password: string | null | undefined) {
  if (password === undefined) return {};
  return {
    passwordEnc: password === null ? null : seal(password, `credential:${id}`),
    // И при стирании: `secret` не очищается, и стёртый пароль вернулся бы переносом.
    secretMigratedAt: new Date(),
  };
}

/** Смена пароля должна быть видна в журнале, значение — нет. */
function passwordDiff(password: string | null | undefined) {
  if (password === undefined) return undefined;
  return { password: password === null ? "cleared" : "set" };
}

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.get("/credentials", { preHandler: requireAdmin }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return invalidInput(reply, query.error);

    const where: Prisma.CredentialWhereInput = { deletedAt: null };
    if (query.data.search) {
      const search = query.data.search;
      where.OR = [
        { service: { contains: search, mode: "insensitive" } },
        { login: { contains: search, mode: "insensitive" } },
        { owner: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    const credentials = await prisma.credential.findMany({
      include: PROJECT_BRIEF,
      where,
      // Сначала то, что скоро продлевать; без даты — в конце по алфавиту.
      orderBy: [{ renewsAt: { sort: "asc", nulls: "last" } }, { service: "asc" }],
      take: 500,
    });

    return reply.send({ credentials: credentials.map(toDto) });
  });

  app.post("/credentials", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    if (typeof input.secret === "string") return sendClientOutdated(reply);
    // До любой записи: половина правки не должна сохраниться.
    if (typeof input.password === "string" && !canVault) return sendNoVaultKey(reply);

    // Заранее, потому что идентификатор входит в AAD шифротекста.
    const id = randomUUID();
    const credential = await prisma.credential.create({
      include: PROJECT_BRIEF,
      data: {
        id,
        service: input.service,
        login: input.login ?? null,
        url: input.url ?? null,
        owner: input.owner ?? null,
        projectId: input.projectId ?? null,
        ...passwordChange(id, input.password),
        renewsAt: input.renewsAt ?? null,
        amountMinor: input.amountMinor ?? null,
        monthlyFee: input.monthlyFee ?? false,
        currency: input.currency ?? "rub",
        notes: input.notes ?? null,
      },
    });

    await audit(request, {
      entity: "credentials",
      entityId: credential.id,
      action: "create",
      diff: passwordDiff(input.password),
    });
    return reply.code(201).send({ credential: toDto(credential) });
  });

  app.patch("/credentials/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const parsed = updateBody.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const input = parsed.data;
    if (typeof input.secret === "string") return sendClientOutdated(reply);
    if (typeof input.password === "string" && !canVault) return sendNoVaultKey(reply);

    const existing = await prisma.credential.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

    const credential = await prisma.credential.update({
      include: PROJECT_BRIEF,
      where: { id: existing.id },
      data: {
        ...(input.service !== undefined && { service: input.service }),
        ...(input.login !== undefined && { login: input.login }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.owner !== undefined && { owner: input.owner }),
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...passwordChange(existing.id, input.password),
        ...(input.renewsAt !== undefined && { renewsAt: input.renewsAt }),
        ...(input.amountMinor !== undefined && { amountMinor: input.amountMinor }),
        ...(input.monthlyFee !== undefined && { monthlyFee: input.monthlyFee }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
    });

    await audit(request, {
      entity: "credentials",
      entityId: credential.id,
      action: "update",
      diff: passwordDiff(input.password),
    });
    return reply.send({ credential: toDto(credential) });
  });

  app.delete("/credentials/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalidInput(reply, params.error);

    const existing = await prisma.credential.findFirst({
      where: { id: params.data.id, deletedAt: null },
    });
    if (!existing) return reply.code(404).send({ error: "Запись не найдена" });

    // Пароль стирается насовсем, хотя сама запись удаляется мягко. Шифротекст без
    // ключа нечитаем, но хранить его вечно незачем: он уезжает в каждый ночной дамп и
    // переживёт любую будущую ошибку в криптографии. Цена — восстановленная запись
    // придёт без пароля. `secret` не трогается: он уйдёт вместе со строкой при очистке
    // корзины, а до тех пор остаётся запасом на случай отката API.
    await prisma.credential.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), passwordEnc: null },
    });

    await audit(request, {
      entity: "credentials",
      entityId: existing.id,
      action: "delete",
      diff: { service: existing.service },
    });
    return reply.code(204).send();
  });

  /**
   * Открыть пароль. Порядок строгий: сначала второй фактор, затем запись в журнал и
   * только потом расшифровка. Журнал пишется напрямую, а не через `audit()`, который
   * глотает ошибки: нет записи — нет пароля.
   */
  app.post(
    "/credentials/:id/reveal",
    { preHandler: REVEAL_GUARDS, config: REVEAL_LIMIT },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const body = codeBody.safeParse(request.body ?? {});
      if (!body.success) return invalidInput(reply, body.error);

      if (!(await confirmSecondFactor(request, reply, body.data.code))) return reply;
      const confirmedUntil = request.authSession!.twoFactorConfirmedUntil?.toISOString();

      const credential = await prisma.credential.findFirst({
        where: { id: params.data.id, deletedAt: null },
      });
      if (!credential) return reply.code(404).send({ error: "Запись не найдена" });

      void reply.header("Cache-Control", "no-store");

      if (!credential.passwordEnc) {
        if (isLegacyPending(credential)) {
          return reply.code(409).send({
            error: "Этот пароль ещё не перенесён: нажмите «Перенести пароли»",
            code: "legacy_pending",
          });
        }
        return reply.send({ password: null, confirmedUntil });
      }

      await prisma.auditLog.create({
        data: {
          userId: request.user!.id,
          ip: request.ip,
          entity: "credentials",
          entityId: credential.id,
          action: "reveal",
          diff: { service: credential.service },
        },
      });

      let password: string;
      try {
        password = open(credential.passwordEnc, `credential:${credential.id}`);
      } catch {
        return reply.code(503).send({
          error: "Пароль не расшифровывается: ключ на сервере не тот, которым он записан",
          code: "vault_key_mismatch",
        });
      }

      return reply.send({ password, confirmedUntil });
    },
  );

  /**
   * Старые шифротексты для переноса. Это такой же просмотр паролей, только расшифровка
   * идёт в браузере, поэтому те же второй фактор и журнал: фразу знает вся команда, и
   * без них маршрут отдал бы человеку без 2FA все пароли, не оставив следа. POST вместо
   * GET, потому что код передаётся в теле, а адрес попадает в логи.
   */
  app.post(
    "/credentials/legacy",
    { preHandler: REVEAL_GUARDS, config: MIGRATE_LIMIT },
    async (request, reply) => {
      const body = codeBody.safeParse(request.body ?? {});
      if (!body.success) return invalidInput(reply, body.error);

      if (!(await confirmSecondFactor(request, reply, body.data.code))) return reply;

      const items = await prisma.credential.findMany({
        where: LEGACY_PENDING,
        select: { id: true, service: true, secret: true },
        orderBy: { service: "asc" },
        take: MIGRATE_BATCH,
      });

      await prisma.auditLog.create({
        data: {
          userId: request.user!.id,
          ip: request.ip,
          entity: "vault",
          action: "legacy_read",
          diff: { count: items.length },
        },
      });

      void reply.header("Cache-Control", "no-store");
      return reply.send({ items });
    },
  );

  /**
   * Перенос. Условие стоит в самом запросе, а не в проверке перед ним: иначе пароль,
   * сохранённый в соседней вкладке, затёрся бы старым. По той же причине повтор
   * безопасен: уже перенесённое попадёт в `skipped`.
   */
  app.post(
    "/credentials/migrate",
    { preHandler: REVEAL_GUARDS, config: MIGRATE_LIMIT },
    async (request, reply) => {
      const body = migrateBody.safeParse(request.body ?? {});
      if (!body.success) return invalidInput(reply, body.error);

      if (!(await confirmSecondFactor(request, reply, body.data.code))) return reply;

      const { items } = body.data;
      const now = new Date();
      const results = await prisma.$transaction(
        items.map(({ id, password }) =>
          prisma.credential.updateMany({
            where: { id, ...LEGACY_PENDING },
            data: {
              passwordEnc: seal(password, `credential:${id}`),
              secretMigratedAt: now,
            },
          }),
        ),
      );

      const migrated = results.reduce((sum, { count }) => sum + count, 0);
      const skipped = items.length - migrated;

      await audit(request, {
        entity: "vault",
        action: "migrate",
        diff: { migrated, skipped },
      });
      return reply.send({ migrated, skipped });
    },
  );
}
