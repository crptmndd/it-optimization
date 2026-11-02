import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { memberNameOf } from "../crm/access.js";
import { canVault } from "../crypto/sealed.js";
import { prisma } from "../db.js";
import { env } from "../env.js";

export const SESSION_COOKIE = "itopt_session";

/**
 * В куку уходит случайный секрет, в базу — только его SHA-256. Утечка дампа
 * базы не даёт возможности войти, а отозвать сессию можно мгновенно (в отличие
 * от JWT, который живёт до истечения срока).
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function expiryDate(): Date {
  return new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export async function createSession(
  reply: FastifyReply,
  user: User,
  request: FastifyRequest,
  twoFactorConfirmedUntil?: Date,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = expiryDate();

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      ip: request.ip,
      userAgent: request.headers["user-agent"]?.slice(0, 255),
      twoFactorConfirmedUntil,
    },
  });

  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.COOKIE_SECURE,
    domain: env.COOKIE_DOMAIN || undefined,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    domain: env.COOKIE_DOMAIN || undefined,
  });
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  role: User["role"];
  totpEnabledAt: Date | null;
  /** Человек из команды, которым значится учётка. Нет связи — null, «своего» у неё нет. */
  memberName: string | null;
}

export interface AuthContext {
  user: AuthenticatedUser;
  session: { id: string; twoFactorConfirmedUntil: Date | null };
}

/** Что подгружать к строке `users`, чтобы `memberNameOf` и `toUserDto` знали человека. */
export const WITH_MEMBER = { member: { select: { name: true } } } as const;

/** Пользователь и сессия текущего запроса или null. Просроченные сессии не проходят. */
export async function resolveAuth(request: FastifyRequest): Promise<AuthContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: WITH_MEMBER } },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.disabledAt) return null;

  const { id, email, name, role, totpEnabledAt } = session.user;
  return {
    user: {
      id,
      email,
      name,
      role,
      totpEnabledAt,
      memberName: memberNameOf(session.user),
    },
    session: {
      id: session.id,
      twoFactorConfirmedUntil: session.twoFactorConfirmedUntil,
    },
  };
}

export async function resolveUser(
  request: FastifyRequest,
): Promise<AuthenticatedUser | null> {
  return (await resolveAuth(request))?.user ?? null;
}

/**
 * Что наружу уходит о вошедшем. Перечень явный и один на все ответы: сессия читает
 * строку `users` целиком, вместе с `passwordHash` и `totpSecretEnc`.
 */
export function toUserDto(
  user: {
    id: string;
    email: string;
    name: string | null;
    role: User["role"];
    totpEnabledAt: Date | null;
  } & Parameters<typeof memberNameOf>[0],
) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    memberName: memberNameOf(user),
    twoFactorEnabled: user.totpEnabledAt !== null,
    twoFactorAvailable: canVault,
  };
}

/** Убирает из базы мусор: истёкшие и отозванные сессии. */
export async function purgeExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

/** То же для билетов входа: живут минуты, а строки остались бы навсегда. */
export async function purgeExpiredTickets(): Promise<number> {
  const { count } = await prisma.loginTicket.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
