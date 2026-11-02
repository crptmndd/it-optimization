import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs } from "node:util";
import { prisma } from "../db.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";
import { linkPerson } from "../crm/people.js";

/**
 * Создать пользователя панели или сменить пароль существующему.
 *
 *   npm run user:create -- admin@it-optimization.ru admin
 *   npm run user:create -- kamil@it-optimization.ru employee --name "Камиль"
 *   npm run user:create -- admin@it-optimization.ru            # только сменить пароль
 *   npm run user:create -- admin@it-optimization.ru --enable   # и включить учётку
 *
 * `--name` связывает учётку с человеком из команды так же, как экран «Команда»:
 * человек есть и без учётки — связывает, нет — заводит, уже связан с другой учёткой —
 * отказ. Без связи у сотрудника нет ничего своего.
 *
 * Пароль спрашивается интерактивно и не попадает ни в аргументы команды, ни в
 * историю shell. У существующего пользователя роль меняется только при явном втором
 * аргументе, а отключённая учётка включается только с флагом `--enable`: сброс пароля
 * не должен попутно делать человека админом или возвращать ушедшего.
 *
 * 2FA скрипт не трогает: забытый пароль не повод её снимать. Если учётка переходит к
 * другому человеку, нужен ещё `user:reset-2fa`, иначе вход останется за старым
 * телефоном и старыми кодами.
 *
 * Смена пароля снимает привязку телеграма: чат читает сводку мимо сессий, и отзыв
 * сессий его бы не коснулся. Подключить заново можно в Настройках CRM.
 */
const ROLES = ["admin", "employee"] as const;
type Role = (typeof ROLES)[number];

class PersonTaken extends Error {}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { enable: { type: "boolean" }, name: { type: "string" } },
  });
  const enable = values.enable ?? false;
  const name = values.name?.trim() || undefined;
  const [emailArg, roleArg] = positionals;

  if (!emailArg) {
    console.error(
      'Использование: npm run user:create -- <email> [admin|employee] [--name "Имя"] [--enable]',
    );
    process.exitCode = 1;
    return;
  }
  if (roleArg !== undefined && !isRole(roleArg)) {
    console.error("Роль может быть admin или employee");
    process.exitCode = 1;
    return;
  }

  const email = emailArg.toLowerCase().trim();
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, disabledAt: true, telegramChatId: true },
  });

  // Правило «Команды» не должно обходиться отсюда: система без админа не чинится
  // из интерфейса вообще.
  if (
    existing?.role === "admin" &&
    !existing.disabledAt &&
    roleArg !== undefined &&
    roleArg !== "admin"
  ) {
    const others = await prisma.user.count({
      where: { role: "admin", disabledAt: null, id: { not: existing.id } },
    });
    if (others === 0) {
      console.error("Нельзя понизить последнего админа");
      process.exitCode = 1;
      return;
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const password = await rl.question(`Пароль для ${email}: `);
  rl.close();

  const weak = validatePasswordStrength(password);
  if (weak) {
    console.error(weak);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  // Одной транзакцией: учётка без связи с уже занятым человеком не должна остаться.
  const saved = await prisma
    .$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        create: { email, passwordHash, name, role: roleArg ?? "admin" },
        update: {
          passwordHash,
          ...(name !== undefined && { name }),
          ...(roleArg !== undefined && { role: roleArg }),
          ...(enable && { disabledAt: null }),
        },
      });
      if (name === undefined) return { user, otherPerson: null };

      const member = await tx.teamMember.findUnique({ where: { userId: user.id } });
      if (!member) {
        if (!(await linkPerson(tx, { userId: user.id, name }))) throw new PersonTaken();
        return { user, otherPerson: null };
      }
      // Связь здесь не меняется: на старое имя записаны задачи и проекты.
      const same = member.name.toLowerCase() === name.toLowerCase();
      return { user, otherPerson: same ? null : member.name };
    })
    .catch((cause: unknown) => {
      if (!(cause instanceof PersonTaken)) throw cause;
      console.error(`Человек «${name}» уже связан с другой учёткой`);
      process.exitCode = 1;
      return null;
    });
  if (!saved) return;
  const { user, otherPerson } = saved;

  // Смена пароля должна выкидывать все открытые сессии, а билет входа доказывает
  // только прежний пароль.
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.loginTicket.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: { telegramChatId: null, telegramLinkCode: null, telegramLinkExpiresAt: null },
    }),
    ...(existing?.telegramChatId
      ? [
          prisma.auditLog.create({
            data: {
              userId: user.id,
              entity: "users",
              entityId: user.id,
              action: "telegram_unlink",
              diff: { reason: "password_change" },
            },
          }),
        ]
      : []),
  ]);

  if (otherPerson) {
    console.error(
      `Учётка осталась связана с человеком «${otherPerson}»: --name к связи не применён, изменились только пароль и имя учётки. Сменить человека можно только в таблице team_members.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Готово: ${user.email} (${user.role})`);
  if (user.disabledAt) console.log("Учётка отключена: включить можно флагом --enable");
}

main()
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
