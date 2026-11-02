import type { UserRole } from "@/auth/auth-context";
import { api } from "./client";

export interface TeamMember {
  id: string;
  name: string | null;
  email: string;
}

export async function listTeam(): Promise<TeamMember[]> {
  const { team } = await api.get<{ team: TeamMember[] }>("/team");
  return team;
}

/** Имя для списков: оно необязательное, поэтому запасной вариант — почта. */
export function memberLabel(
  member: { name: string | null; email: string } | null,
): string {
  if (!member) return "";
  return member.name ?? member.email;
}

/** Учётка для раздела «Команда»: хэшей и секретов сервер сюда не кладёт. */
export interface Account {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  /** Человек из команды, которым значится учётка. Ключ для общего списка в «Команде». */
  memberName: string | null;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
  createdAt: string;
}

export interface AccountInput {
  email: string;
  name: string;
  role: UserRole;
  password: string;
  telegramUsername?: string | null;
}

/**
 * Пароль админа на каждое изменение учёток: иначе украденной куки хватило бы, чтобы
 * завести свою учётку и подключить на ней свою 2FA. Код нужен, только если у админа
 * включена 2FA и нет открытого окна.
 */
export interface AdminConfirm {
  password: string;
  code?: string;
}

/**
 * Человек команды, в том числе без учётки: исполнителем бывает и он. `name` — ключ, его
 * значение лежит в `developers` задач и проектов. Почт здесь нет: список читает вся
 * команда.
 */
export interface TeamHandle {
  name: string;
  telegramUsername: string | null;
  /** false — учётка отключена. Имя остаётся в истории, но новую работу не назначить. */
  active: boolean;
  /** `null` у человека без учётки. */
  role: UserRole | null;
  hasAccount: boolean;
}

/** Сервер меняет только присланных, остальных можно не отправлять. */
export type HandleInput = Pick<TeamHandle, "name" | "telegramUsername">;

export async function listAccounts(): Promise<Account[]> {
  const { accounts } = await api.get<{ accounts: Account[] }>("/team/accounts");
  return accounts;
}

export async function createAccount(
  input: AccountInput,
  confirm: AdminConfirm,
): Promise<Account> {
  const { account } = await api.post<{ account: Account }>("/team/accounts", {
    ...input,
    confirm,
  });
  return account;
}

export async function setAccountDisabled(
  id: string,
  disabled: boolean,
  confirm: AdminConfirm,
): Promise<Account> {
  const { account } = await api.patch<{ account: Account }>(`/team/accounts/${id}`, {
    disabled,
    confirm,
  });
  return account;
}

export async function setAccountRole(
  id: string,
  role: UserRole,
  confirm: AdminConfirm,
): Promise<Account> {
  const { account } = await api.patch<{ account: Account }>(`/team/accounts/${id}`, {
    role,
    confirm,
  });
  return account;
}

export async function listHandles(): Promise<TeamHandle[]> {
  const { handles } = await api.get<{ handles: TeamHandle[] }>("/team/handles");
  return handles;
}

export async function saveHandles(handles: HandleInput[]): Promise<TeamHandle[]> {
  const saved = await api.put<{ handles: TeamHandle[] }>("/team/handles", { handles });
  return saved.handles;
}
