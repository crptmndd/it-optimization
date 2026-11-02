import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAdmin, requireTeam } from "../auth/guard.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";
import { confirmAdmin, totpCode } from "../auth/two-factor.js";
import { prisma } from "../db.js";
import { isPrivateChat } from "../notify/notifications.js";
import { memberNameOf } from "./access.js";
import { invalidInput } from "./http.js";
import { assertDevelopers, linkPerson } from "./people.js";

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
  telegramChatId: true,
  lastLoginAt: true,
  disabledAt: true,
  createdAt: true,
  member: { select: { name: true } },
} as const;

type AccountRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT_FIELDS }>;

function toAccountDto(row: AccountRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    memberName: memberNameOf(row),
    twoFactorEnabled: row.totpEnabledAt !== null,
    // Сам чат наружу не отдаётся. Админу без лички бот не напишет ничего.
    telegramLinked: Boolean(row.telegramChatId && isPrivateChat(row.telegramChatId)),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const idParams = z.object({ id: z.string().uuid() });

/** Что можно назначить. `marketing` живёт только в enum базы: удалить значение нельзя. */
const ACCOUNT_ROLES = ["admin", "employee"] as const;

/** Подтверждение админа: см. `confirmAdmin`. Без него куки хватило бы на всё. */
const confirmField = z.object({
  password: z.string().min(1).max(200),
  code: totpCode.optional(),
});

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

const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(ACCOUNT_ROLES).default("employee"),
  password: z.string().min(1).max(200),
  telegramUsername: handleField.optional(),
  confirm: confirmField,
});

const updateBody = z
  .object({
    disabled: z.boolean().optional(),
    role: z.enum(ACCOUNT_ROLES).optional(),
    confirm: confirmField,
  })
  .refine(
    (body) => body.disabled !== undefined || body.role !== undefined,
    "Нужно указать, что менять",
  );

const handlesBody = z.object({
  handles: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        telegramUsername: handleField,
      }),
    )
    .max(200),
});

/**
 * Вся команда, включая людей без учётки: они тоже бывают исполнителями. `active` —
 * можно ли выбрать человека на новую работу: отключена только учётка, а имя остаётся в
 * истории. Сортировка с именем, иначе у заведённых в одну транзакцию порядок плавал бы.
 */
async function listHandles() {
  const rows = await prisma.teamMember.findMany({
    orderBy: [{ createdAt: "asc" }, { name: "asc" }],
    select: {
      name: true,
      telegramUsername: true,
      user: { select: { role: true, disabledAt: true } },
    },
  });
  return rows.map((row) => ({
    name: row.name,
    telegramUsername: row.telegramUsername,
    active: !row.user?.disabledAt,
    role: row.user?.role ?? null,
    hasAccount: row.user !== null,
  }));
}

/** Лимит как у входа: оба маршрута принимают пароль админа. */
const STRICT_LIMIT = { rateLimit: { max: 10, timeWindow: "5 minutes" } };

const PERSON_TAKEN = "Такой сотрудник уже есть";

/** Откатывает транзакцию: учётка без человека осталась бы без единой своей задачи. */
class PersonTaken extends Error {}

/** На какой уникальности сорвалась запись: почта и имя отвечают разными текстами. */
function uniqueTarget(cause: unknown): string | null {
  if (
    !(cause instanceof Prisma.PrismaClientKnownRequestError) ||
    cause.code !== "P2002"
  ) {
    return null;
  }
  return String(cause.meta?.target ?? "");
}

/**
 * `GET /team` — почты всех учёток для выбора ответственного за лид, поэтому только
 * админу: лиды его раздел, а сотрудникам чужие адреса незачем. Людей для «Кто делает»
 * отдаёт `GET /team/handles`, он без почт.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/team", { preHandler: requireAdmin }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { disabledAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });
    return reply.send({ team: users });
  });

  app.get("/team/accounts", { preHandler: requireAdmin }, async (_request, reply) => {
    const accounts = await prisma.user.findMany({
      select: ACCOUNT_FIELDS,
      orderBy: [{ disabledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    });
    return reply.send({ accounts: accounts.map(toAccountDto) });
  });

  /**
   * Новый сотрудник: учётка и человек вместе, одной транзакцией. Если человек с таким
   * именем уже есть и учётки у него нет, он её получает; так появляется вход у того,
   * кто давно значится в задачах.
   */
  app.post(
    "/team/accounts",
    { preHandler: requireAdmin, config: STRICT_LIMIT },
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const { email, name, role, password, telegramUsername, confirm } = parsed.data;
      if (!(await confirmAdmin(request, reply, confirm))) return reply;

      const weak = validatePasswordStrength(password);
      if (weak) return reply.code(400).send({ error: weak });

      const passwordHash = await hashPassword(password);

      let account: AccountRow;
      try {
        account = await prisma.$transaction(async (tx) => {
          const { id } = await tx.user.create({
            data: { email, name, role, passwordHash },
            select: { id: true },
          });
          if (!(await linkPerson(tx, { userId: id, name, telegramUsername }))) {
            throw new PersonTaken();
          }
          return tx.user.findUniqueOrThrow({ where: { id }, select: ACCOUNT_FIELDS });
        });
      } catch (cause) {
        if (cause instanceof PersonTaken) {
          return reply.code(409).send({ error: PERSON_TAKEN });
        }
        const target = uniqueTarget(cause);
        if (target === null) throw cause;
        // Имя занято, если двое завели одного человека одновременно: проверка в
        // `linkPerson` пропустила обоих, а первичный ключ — нет.
        const error = target.includes("email")
          ? "Такая почта уже заведена"
          : PERSON_TAKEN;
        return reply.code(409).send({ error });
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
   * Отключить, включить или сменить роль. Админы блокируются целиком: два админа,
   * отключающие или понижающие друг друга одновременно, иначе оба прошли бы проверку
   * «последний» и оставили бы систему без хозяина. Роль в сыром SQL старая, `owner`:
   * enum в базе не менялся.
   *
   * Сессии при смене роли не отзываются: роль читается на каждом запросе, и понижение
   * действует сразу, а выбрасывать человека из работы незачем.
   */
  app.patch(
    "/team/accounts/:id",
    { preHandler: requireAdmin, config: STRICT_LIMIT },
    async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalidInput(reply, params.error);

      const parsed = updateBody.safeParse(request.body ?? {});
      if (!parsed.success) return invalidInput(reply, parsed.error);

      const { disabled, role, confirm } = parsed.data;
      if (!(await confirmAdmin(request, reply, confirm))) return reply;

      const outcome = await prisma.$transaction(
        async (
          tx,
        ): Promise<
          | { error: [404 | 409, string] }
          | { account: AccountRow; previousRole: AccountRow["role"] }
        > => {
          const admins = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM users WHERE role = 'owner' AND disabled_at IS NULL FOR UPDATE`;

          const target = await tx.user.findUnique({
            where: { id: params.data.id },
            select: ACCOUNT_FIELDS,
          });
          if (!target) return { error: [404, "Учётка не найдена"] };

          const self = target.id === request.user!.id;
          const lastAdmin =
            admins.length === 1 && admins.some((admin) => admin.id === target.id);
          const data: Prisma.UserUpdateInput = {};

          if (role !== undefined && role !== target.role) {
            if (self) return { error: [409, "Нельзя менять свою роль"] };
            if (lastAdmin) return { error: [409, "Нельзя понизить последнего админа"] };
            data.role = role;
          }

          if (disabled === false) data.disabledAt = null;
          if (disabled === true) {
            if (self) return { error: [409, "Нельзя отключить свою учётку"] };
            if (lastAdmin) return { error: [409, "Нельзя отключить последнего админа"] };
            data.disabledAt = target.disabledAt ?? new Date();
          }

          const account = await tx.user.update({
            where: { id: target.id },
            data,
            select: ACCOUNT_FIELDS,
          });

          if (disabled === true) {
            // Сессии отзываются, а не только перестают проходить проверку: иначе
            // обратное включение оживило бы украденную сессию.
            await tx.session.updateMany({
              where: { userId: target.id, revokedAt: null },
              data: { revokedAt: new Date() },
            });
            await tx.loginTicket.deleteMany({ where: { userId: target.id } });
          }
          return { account, previousRole: target.role };
        },
      );

      if ("error" in outcome) {
        const [status, error] = outcome.error;
        return reply.code(status).send({ error });
      }

      const { account, previousRole } = outcome;
      if (disabled !== undefined) {
        await audit(request, {
          entity: "users",
          entityId: account.id,
          action: disabled ? "disable" : "enable",
          diff: { email: account.email, role: account.role },
        });
      }
      if (account.role !== previousRole) {
        await audit(request, {
          entity: "users",
          entityId: account.id,
          action: "role",
          diff: { email: account.email, role: { from: previousRole, to: account.role } },
        });
      }
      return reply.send({ account: toAccountDto(account) });
    },
  );

  // Читать может вся команда: выбор «Кто делает» строится отсюда, и форма задачи
  // показывает, кого бот сможет отметить. Менять — только админ.
  app.get("/team/handles", { preHandler: requireTeam }, async (_request, reply) => {
    return reply.send({ handles: await listHandles() });
  });

  app.put("/team/handles", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = handlesBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidInput(reply, parsed.error);

    const { handles } = parsed.data;
    const problem = await assertDevelopers(handles.map((item) => item.name));
    if (problem) return reply.code(400).send({ error: problem });

    await prisma.$transaction(
      handles.map(({ name, telegramUsername }) =>
        prisma.teamMember.update({
          where: { name },
          data: { telegramUsername: telegramUsername || null },
        }),
      ),
    );

    await audit(request, { entity: "team_members", action: "update" });
    return reply.send({ handles: await listHandles() });
  });
}
