import { prisma } from "../db.js";

/**
 * Снять 2FA с учётки, если потеряны и телефон, и коды восстановления.
 *
 *   npm run user:reset-2fa -- admin@it-optimization.ru
 *
 * Единственный выход из такой ситуации, и интерфейса для него нет намеренно: кнопка
 * «снять чужую 2FA» стала бы способом обойти второй фактор с украденной сессией
 * владельца. Здесь нужен доступ к серверу.
 *
 * Открытые сессии человека не отзываются, но окна подтверждения у них гаснут.
 */
async function main(): Promise<void> {
  const [emailArg] = process.argv.slice(2);

  if (!emailArg) {
    console.error("Использование: npm run user:reset-2fa -- <email>");
    process.exitCode = 1;
    return;
  }

  const email = emailArg.toLowerCase().trim();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) {
    console.error(`Учётка ${email} не найдена`);
    process.exitCode = 1;
    return;
  }

  // Одной транзакцией: оставшийся билет или окно пережили бы снятие 2FA.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastStep: null,
        totpFailedAttempts: 0,
        totpLockedUntil: null,
        totpSetupAt: null,
      },
    }),
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.loginTicket.deleteMany({ where: { userId: user.id } }),
    prisma.session.updateMany({
      where: { userId: user.id },
      data: { twoFactorConfirmedUntil: null },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        entity: "users",
        entityId: user.id,
        action: "2fa_reset_cli",
      },
    }),
  ]);

  console.log(`Готово: 2FA снята, ${email} снова входит по паролю`);
}

main()
  .catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
