import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { prisma } from "./db.js";

/**
 * Запись в журнал никогда не должна ронять основную операцию: если журнал
 * недоступен, правка всё равно сохранена, а сбой уходит в логи.
 */
export async function audit(
  request: FastifyRequest,
  entry: {
    entity: string;
    entityId?: string;
    action: string;
    diff?: Prisma.InputJsonValue;
    /** На шаге входа `request.user` ещё пуст, и строка вышла бы без автора. */
    userId?: string;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? request.user?.id ?? null,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        action: entry.action,
        diff: entry.diff,
        ip: request.ip,
      },
    });
  } catch (cause) {
    request.log.error({ cause }, "не удалось записать audit_log");
  }
}

/**
 * Запись без HTTP-запроса: бот действует от имени человека, но приходит не из браузера,
 * и адреса у такого действия нет. Правило то же: журнал не роняет саму операцию.
 */
export async function auditAs(
  userId: string,
  entry: {
    entity: string;
    entityId?: string;
    action: string;
    diff?: Prisma.InputJsonValue;
  },
  log: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        action: entry.action,
        diff: entry.diff,
      },
    });
  } catch (cause) {
    log.error({ err: cause }, "не удалось записать audit_log");
  }
}
