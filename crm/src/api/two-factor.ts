import { api } from "./client";

export interface TwoFactorStatus {
  /** На сервере задан ключ. Нет — подключить 2FA нельзя. */
  available: boolean;
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  /** Рисует сервер: не растёт бандл, а секрет никуда больше не уходит. */
  qrSvg: string;
}

export const twoFactorApi = {
  status: () => api.get<TwoFactorStatus>("/auth/2fa/status"),
  setup: (password: string) => api.post<TwoFactorSetup>("/auth/2fa/setup", { password }),
  enable: (code: string) =>
    api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code }),
  cancelSetup: () => api.post<void>("/auth/2fa/cancel"),
  regenerateCodes: (code: string) =>
    api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { code }),
  disable: (password: string, code: string) =>
    api.post<void>("/auth/2fa/disable", { password, code }),
};
