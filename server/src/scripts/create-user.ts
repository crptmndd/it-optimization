import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { prisma } from "../db.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";

/**
 * Создать пользователя панели или сменить пароль существующему.
 *
 *   npm run user:create -- admin@it-optimization.ru owner
 *   npm run user:create -- admin@it-optimization.ru            # только сменить пароль
 *   npm run user:create -- admin@it-optimization.ru --enable   # и включить учётку
 *
 * Пароль спрашивается интерактивно и не попадает ни в аргументы команды, ни в
 * историю shell. У существующего пользователя роль меняется только при явном втором
 * аргументе, а отключённая учётка включается только с флагом `--enable`: сброс пароля
 * не должен попутно делать человека владельцем или возвращать ушедшего.
 *
 * 2FA скрипт не трогает: забытый пароль не повод её снимать. Если учётка переходит к
 * другому человеку, нужен ещё `user:reset-2fa`, иначе вход останется за старым
 * телефоном и старыми кодами.
 */
const ROLES = ["owner", "editor", "marketing"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const enable = args.includes("--enable");
  const [emailArg, roleArg] = args.filter((arg) => arg !== "--enable");

  if (!emailArg) {
    console.error(
      "Использование: npm run user:create -- <email> [owner|editor|marketing] [--enable]",
    );
    process.exitCode = 1;
    return;
  }
  if (roleArg !== undefined && !isRole(roleArg)) {
    console.error(
      "Роль может быть owner, editor или marketing (marketing — только раздел лидов)",
    );
    process.exitCode = 1;
    return;
  }

  const email = emailArg.toLowerCase().trim();
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, disabledAt: true },
  });

  // Правило «Команды» не должно обходиться отсюда: система без владельца не чинится
  // из интерфейса вообще.
  if (
    existing?.role === "owner" &&
    !existing.disabledAt &&
    roleArg !== undefined &&
    roleArg !== "owner"
  ) {
    const others = await prisma.user.count({
      where: { role: "owner", disabledAt: null, id: { not: existing.id } },
    });
    if (others === 0) {
      console.error("Нельзя понизить последнего владельца");
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
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role: roleArg ?? "owner" },
    update: {
      passwordHash,
      ...(roleArg !== undefined && { role: roleArg }),
      ...(enable && { disabledAt: null }),
    },
  });

  // Смена пароля должна выкидывать все открытые сессии, а билет входа доказывает
  // только прежний пароль.
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.loginTicket.deleteMany({ where: { userId: user.id } }),
  ]);

  console.log(`Готово: ${user.email} (${user.role})`);
  if (user.disabledAt) console.log("Учётка отключена: включить можно флагом --enable");
}

main()
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
