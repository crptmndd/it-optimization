import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAuth, requireOwner } from "../auth/guard.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";
import { confirmOwner, totpCode } from "../auth/two-factor.js";
import { prisma } from "../db.js";
import { DEVELOPERS } from "./developers.js";
import { invalidInput } from "./http.js";

/**
 * Учётки только через этот перечень: в строке `users` лежат `passwordHash` и
 * `totpSecretEnc`, и наружу они не уходят ни при какой правке DTO.
 */
const ACCOUNT_FIELDS = {
  id: true,
  email: true,
  name: true,
  role: true,
  totpEnabledAt: true,
  lastLoginAt: true,
  disabledAt: true,
  createdAt: true,
} as const;

type AccountRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT_FIELDS }>;

function toAccountDto(row: AccountRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    twoFactorEnabled: row.totpEnabledAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

/** Подтверждение владельца: см. `confirmOwner`. Без него куки хватило бы на всё. */
const confirmField = z.object({
  password: z.string().min(1).max(200),
  code: totpCode.optional(),
});

const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(["owner", "editor", "marketing"]),
  password: z.string().min(1).max(200),
  confirm: confirmField,
});

const updateBody = z.object({ disabled: z.boolean(), confirm: confirmField });

const handleField = z.union([
  z.null(),
  z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ""))
    .refine(
      (value) => value === "" || /^[A-Za-z0-9_]{5,32}$/.test(value),
      "Ник Telegram — от 5 до 32 латинских букв, цифр или подчёркиваний",
    ),
]);

const handlesBody = z.object({
  handles: z
    .array(z.object({ name: z.enum(DEVELOPERS), telegramUsername: handleField }))
    .max(DEVELOPERS.length),
});

async function listHandles() {
  const rows = await prisma.teamMember.findMany();
  const byName = new Map(rows.map((row) => [row.name, row.telegramUsername]));
  // Все имена, а не только сохранённые: строки нет — ника нет, и это обычное
  // состояние, а экрану нужен полный список полей.
  return DEVELOPERS.map((name) => ({
    name,
    telegramUsername: byName.get(name) ?? null,
  }));
}

/** Лимит как у входа: оба маршрута принимают пароль владельца. */
const STRICT_LIMIT = { rateLimit: { max: 10, timeWindow: "5 minutes" } };

/**
 * `GET /team` — справочник для выпадающих «кто ведёт» и «исполнитель»: только имя и
 * почта, ролей и дат входа там быть не должно. Управление учётками отдельно и только
 * у владельца.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/team", { preHandler: requireAuth }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { disabledAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });
    return reply.send({ team: users });
  });

  app.get("/team/accounts", { preHandler: requireOwner }, async (_request, reply) => {
    const accounts = await prisma.user.findMany({
      select: ACCOUNT_FIELDS,
      orderBy: [{ disabledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
    return reply.send({ accounts: accounts.map(toAccountDto) });
  });

  app.post(
    "/team/accounts",
    { preHandler: requireOwner, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const { email, name, role, password, confirm } = parsed.data;
      if (!(await confirmOwner(request, reply, confirm))) return reply;

      const weak = validatePasswordStrength(password);
      if (weak) return reply.code(400).send({ error: weak });

      const passwordHash = await hashPassword(password);

      let account: AccountRow;
      try {
        account = await prisma.user.create({
          data: { email, name, role, passwordHash },
          select: ACCOUNT_FIELDS,
        });
      } catch (cause) {
        if (
          cause instanceof Prisma.PrismaClientKnownRequestError &&
          cause.code === "P2002"
        ) {
          return reply.code(409).send({ error: "Такая почта уже заведена" });
        }
        throw cause;
      }

      await audit(request, {
        entity: "users",
        entityId: account.id,
        action: "create",
        diff: { email: account.email, role: account.role },
      });
      return reply.code(201).send({ account: toAccountDto(account) });
    },
  );

  /**
   * Отключить или включить учётку. Владельцы блокируются целиком: два владельца,
   * отключающие друг друга одновременно, иначе оба прошли бы проверку «последний» и
   * оставили бы систему без хозяина.
   */
  app.patch(
    "/team/accounts/:id",
    { preHandler: requireOwner, config: STRICT_LIMIT },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const parsed = updateBody.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const { disabled, confirm } = parsed.data;
      if (!(await confirmOwner(request, reply, confirm))) return reply;

      const outcome = await prisma.$transaction(
        async (tx): Promise<{ error: [404 | 409, string] } | { account: AccountRow }> => {
          const owners = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL FOR UPDATE`;

          const target = await tx.user.findUnique({
            where: { id: params.data.id },
            select: ACCOUNT_FIELDS,
          });
          if (!target) return { error: [404, "Учётка не найдена"] };

          if (!disabled) {
            const account = await tx.user.update({
              where: { id: target.id },
              data: { disabledAt: null },
              select: ACCOUNT_FIELDS,
            });
            return { account };
          }

          if (target.id === request.user!.id) {
            return { error: [409, "Нельзя отключить свою учётку"] };
          }
          const isActiveOwner = owners.some((owner) => owner.id === target.id);
          if (isActiveOwner && owners.length === 1) {
            return { error: [409, "Нельзя отключить последнего владельца"] };
          }

          const now = new Date();
          const account = await tx.user.update({
            where: { id: target.id },
            data: { disabledAt: target.disabledAt ?? now },
            select: ACCOUNT_FIELDS,
          });
          // Сессии отзываются, а не только перестают проходить проверку: иначе
          // обратное включение оживило бы украденную сессию.
          await tx.session.updateMany({
            where: { userId: target.id, revokedAt: null },
            data: { revokedAt: now },
          });
          await tx.loginTicket.deleteMany({ where: { userId: target.id } });
          return { account };
        },
      );

      if ("error" in outcome) {
        const [status, error] = outcome.error;
        return reply.code(status).send({ error });
      }

      await audit(request, {
        entity: "users",
        entityId: outcome.account.id,
        action: disabled ? "disable" : "enable",
        diff: { email: outcome.account.email, role: outcome.account.role },
      });
      return reply.send({ account: toAccountDto(outcome.account) });
    },
  );

  app.get("/team/handles", { preHandler: requireOwner }, async (_request, reply) => {
    return reply.send({ handles: await listHandles() });
  });

  app.put("/team/handles", { preHandler: requireOwner }, async (request, reply) => {
    const parsed = handlesBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidInput(reply, parsed.error);

    await prisma.$transaction(
      parsed.data.handles.map(({ name, telegramUsername }) => {
        const username = telegramUsername || null;
        return prisma.teamMember.upsert({
          where: { name },
          create: { name, telegramUsername: username },
          update: { telegramUsername: username },
        });
      }),
    );

    await audit(request, { entity: "team_members", action: "update" });
    return reply.send({ handles: await listHandles() });
  });
}
