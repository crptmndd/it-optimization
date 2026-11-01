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
}

/**
 * Пароль владельца на каждое изменение учёток: иначе украденной куки хватило бы,
 * чтобы завести свою учётку и подключить на ней свою 2FA. Код нужен, только если у
 * владельца включена 2FA и нет открытого окна.
 */
export interface OwnerConfirm {
  password: string;
  code?: string;
}

export interface TeamHandle {
  name: string;
  telegramUsername: string | null;
}

export async function listAccounts(): Promise<Account[]> {
  const { accounts } = await api.get<{ accounts: Account[] }>("/team/accounts");
  return accounts;
}

export async function createAccount(
  input: AccountInput,
  confirm: OwnerConfirm,
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
  confirm: OwnerConfirm,
): Promise<Account> {
  const { account } = await api.patch<{ account: Account }>(`/team/accounts/${id}`, {
    disabled,
    confirm,
  });
  return account;
}

export async function listHandles(): Promise<TeamHandle[]> {
  const { handles } = await api.get<{ handles: TeamHandle[] }>("/team/handles");
  return handles;
}

export async function saveHandles(handles: TeamHandle[]): Promise<TeamHandle[]> {
  const saved = await api.put<{ handles: TeamHandle[] }>("/team/handles", { handles });
  return saved.handles;
}
