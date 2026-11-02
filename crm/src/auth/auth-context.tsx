import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "@/api/client";

/**
 * Две роли. Скрытие разделов здесь вторично: настоящий запрет стоит на сервере, он
 * читает роль на каждом запросе. Значения совпадают с API, а не с базой: там enum
 * остался прежним ради отката.
 */
export type UserRole = "admin" | "employee";

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  /**
   * Человек из команды, которым значится учётка: это его имя лежит в `developers`
   * задач. Первое слово `name` больше не угадываем: `null` значит, что своих задач у
   * учётки нет.
   */
  memberName: string | null;
  twoFactorEnabled: boolean;
  /** На сервере задан ключ: без него 2FA подключить нельзя. */
  twoFactorAvailable: boolean;
}

/** Пароль принят. При включённой 2FA сессии ещё нет: нужен код и этот билет. */
export type LoginResult = { status: "done" } | { status: "two_factor"; ticket: string };

type LoginResponse = { user: User } | { twoFactorRequired: true; ticket: string };

/**
 * Три состояния вместо `user | null`: пока идёт первая проверка сессии, нельзя
 * ни показать приложение, ни выкинуть на форму входа — иначе при каждом
 * обновлении страницы моргает логин.
 */
type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: User }
  | { status: "anonymous" };

interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeTwoFactor: (ticket: string, code: string) => Promise<void>;
  /** Перечитать пользователя: после подключения 2FA баннер должен уйти сам. */
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  // Кука httpOnly, прочитать её из JS нельзя — про наличие сессии спрашиваем
  // сервер. Это же проверяет, что API вообще доступен.
  useEffect(() => {
    let cancelled = false;

    api
      .get<{ user: User }>("/auth/me")
      .then(({ user }) => {
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "anonymous" });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const result = await api.post<LoginResponse>("/auth/login", { email, password });
      if ("twoFactorRequired" in result) {
        return { status: "two_factor", ticket: result.ticket };
      }
      setState({ status: "authenticated", user: result.user });
      return { status: "done" };
    },
    [],
  );

  const completeTwoFactor = useCallback(async (ticket: string, code: string) => {
    const { user } = await api.post<{ user: User }>("/auth/login/2fa", { ticket, code });
    setState({ status: "authenticated", user });
  }, []);

  const refreshUser = useCallback(async () => {
    const { user } = await api.get<{ user: User }>("/auth/me");
    setState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post<void>("/auth/logout");
    } catch (error) {
      // Сессия могла истечь сама — для пользователя это всё равно выход.
      if (!(error instanceof ApiError)) throw error;
    }
    setState({ status: "anonymous" });
  }, []);

  const value = useMemo(
    () => ({ state, login, completeTwoFactor, refreshUser, logout }),
    [state, login, completeTwoFactor, refreshUser, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth вызван вне AuthProvider");
  return context;
}

/** Одно место, где интерфейс решает, чьи разделы показывать. */
export function isAdmin(user: { role: UserRole }): boolean {
  return user.role === "admin";
}

/** Пользователь внутри защищённой части — там он гарантированно есть. */
export function useCurrentUser(): User {
  const { state } = useAuth();
  if (state.status !== "authenticated") {
    throw new Error("useCurrentUser вызван вне защищённого маршрута");
  }
  return state.user;
}
