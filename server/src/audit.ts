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
