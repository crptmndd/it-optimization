import { api } from "./client";

export interface TelegramStatus {
  /** Бот настроен на сервере. Ложь — подключать нечего, и это не ошибка. */
  available: boolean;
  connected: boolean;
}

export interface LinkCode {
  code: string;
  expiresAt: string;
}

export const telegramApi = {
  status: () => api.get<TelegramStatus>("/telegram/status"),
  requestCode: (password: string) =>
    api.post<LinkCode>("/telegram/link-code", { password }),
  unlink: () => api.post<void>("/telegram/unlink"),
};

/** Имя бота — часть ссылки t.me, поэтому вынесено в переменную окружения. */
export const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME ?? "it_optimization_bot";
