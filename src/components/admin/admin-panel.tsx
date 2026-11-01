"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { ADMIN_REPO, TOKEN_STORAGE_KEY } from "@/lib/admin/github";
import { githubCasesApi, type CasesApi } from "@/lib/admin/cases-api";
import { githubBlogApi, type BlogApi } from "@/lib/admin/blog-api";
import { githubServicesApi, type ServicesApi } from "@/lib/admin/services-api";
import { httpBlogApi, httpCasesApi, httpServicesApi } from "@/lib/admin/http-api";
import {
  ADMIN_MODE,
  fetchCurrentUser,
  signIn,
  signOut,
  TicketExpiredError,
  verifySecondFactor,
  type AdminUser,
} from "@/lib/admin/auth";
import { CasesPanel } from "./cases-panel";
import { BlogPanel } from "./blog-panel";
import { ServicesPanel } from "./services-panel";
import type { PanelTab } from "./panel-chrome";

/**
 * Панель управления контентом сайта: кейсы, блог и каталог услуг.
 *
 * Здесь живёт только вход — каким способом панель авторизуется (пароль против
 * своего API или личный токен GitHub) и куда после этого пишет каждый раздел.
 * Сами разделы про этот выбор не знают: им отдают готовый `CasesApi`,
 * `BlogApi` или `ServicesApi`.
 *
 * Все разделы смонтированы одновременно, а неактивные просто скрыты. Это
 * намеренно: незаконченная правка живёт в состоянии панели, и переключение
 * вкладки не должно её терять.
 */
export function AdminPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  /** Вошедший пользователь — только в режиме собственного API. */
  const [user, setUser] = useState<AdminUser | null>(null);
  /** Пока не проверили сессию, показывать форму входа рано. */
  const [authReady, setAuthReady] = useState(ADMIN_MODE === "github");
  const [tab, setTab] = useState<PanelTab>("cases");

  useEffect(() => {
    if (ADMIN_MODE === "github") {
      // Токен уже вставляли — открываемся сразу на списке.
      const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) setToken(stored);
      return;
    }
    // Сессия живёт в httpOnly-куке, прочитать её из JS нельзя — спрашиваем сервер.
    void fetchCurrentUser()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setAuthReady(true));
  }, []);

  /** Куда панель пишет кейсы: своё API с логином или репозиторий по токену. */
  const casesApi = useMemo<CasesApi | null>(() => {
    if (ADMIN_MODE === "api") return user ? httpCasesApi() : null;
    return token ? githubCasesApi(token) : null;
  }, [token, user]);

  /** То же самое для статей. */
  const blogApi = useMemo<BlogApi | null>(() => {
    if (ADMIN_MODE === "api") return user ? httpBlogApi() : null;
    return token ? githubBlogApi(token) : null;
  }, [token, user]);

  /** И для каталога услуг — разделов и их состава. */
  const servicesApi = useMemo<ServicesApi | null>(() => {
    if (ADMIN_MODE === "api") return user ? httpServicesApi() : null;
    return token ? githubServicesApi(token) : null;
  }, [token, user]);

  const saveToken = () => {
    const value = tokenInput.trim();
    if (!value) return;
    window.localStorage.setItem(TOKEN_STORAGE_KEY, value);
    setToken(value);
    setTokenInput("");
  };

  /** Билет второго шага или `null`, если вход уже состоялся. */
  const logIn = async (email: string, password: string) => {
    const result = await signIn(email, password);
    if ("ticket" in result) return result.ticket;
    setUser(result.user);
    return null;
  };

  const confirmCode = async (ticket: string, code: string) => {
    setUser(await verifySecondFactor(ticket, code));
  };

  const logOut = async () => {
    if (ADMIN_MODE === "api") {
      await signOut();
      setUser(null);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      setToken(null);
    }
  };

  if (!authReady) {
    return (
      <div className="text-muted-foreground flex min-h-screen items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Проверяю сессию…
      </div>
    );
  }

  if (ADMIN_MODE === "api" && !user) {
    return <LoginGate onSubmit={logIn} onCode={confirmCode} />;
  }

  if (ADMIN_MODE === "github" && !token) {
    return <TokenGate value={tokenInput} onChange={setTokenInput} onSubmit={saveToken} />;
  }

  if (!casesApi || !blogApi || !servicesApi) return null;

  const chrome = {
    tab,
    onTab: setTab,
    onLogout: () => void logOut(),
    userEmail: user?.email ?? null,
  };

  return (
    <>
      <div className={tab === "cases" ? undefined : "hidden"}>
        <CasesPanel api={casesApi} {...chrome} />
      </div>
      <div className={tab === "blog" ? undefined : "hidden"}>
        <BlogPanel api={blogApi} {...chrome} />
      </div>
      <div className={tab === "services" ? undefined : "hidden"}>
        <ServicesPanel api={servicesApi} {...chrome} />
      </div>
    </>
  );
}

function LoginGate({
  onSubmit,
  onCode,
}: {
  onSubmit: (email: string, password: string) => Promise<string | null>;
  onCode: (ticket: string, code: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /** Билет между паролем и кодом. Только здесь: ни в адрес, ни в localStorage. */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const issued = await onSubmit(email.trim(), password);
      // Пароль больше не нужен, и держать его в памяти незачем.
      if (issued) {
        setTicket(issued);
        setPassword("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const backToPassword = (message: string | null = null) => {
    setTicket(null);
    setCode("");
    setError(message);
  };

  const submitCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      await onCode(ticket, code.trim());
    } catch (cause) {
      if (cause instanceof TicketExpiredError) {
        backToPassword(cause.message);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  };

  const errorNote = error && (
    <p className="mt-4 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error}</span>
    </p>
  );

  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center px-5">
      {/* Разные key: иначе React переделал бы поле почты в поле кода, autoFocus не
          сработал бы, а кнопка «Войти» перетекла бы в «Назад» через чёрный фон. */}
      {ticket ? (
        <form
          key="code"
          onSubmit={submitCode}
          className="border-border bg-background w-full max-w-sm rounded-2xl border p-6"
        >
          <h1 className="font-display text-xl">Код подтверждения</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Шесть цифр из приложения. Телефона нет — код восстановления.
          </p>

          {/* inputMode="text": в коде восстановления есть буквы. */}
          <label className="mt-6 block text-sm font-medium">
            Код
            <input
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="border-border focus:border-foreground mt-1.5 h-11 w-full rounded-lg border px-3 text-base outline-none"
            />
          </label>

          {errorNote}

          <button
            type="submit"
            disabled={busy}
            className="bg-foreground text-background hover:bg-accent hover:text-accent-foreground mt-6 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Войти
          </button>
          <button
            type="button"
            onClick={() => backToPassword()}
            className="text-muted-foreground hover:text-foreground mt-3 w-full cursor-pointer text-sm transition-colors"
          >
            Назад
          </button>
        </form>
      ) : (
        <form
          key="password"
          onSubmit={submit}
          className="border-border bg-background w-full max-w-sm rounded-2xl border p-6"
        >
          <h1 className="font-display text-xl">Вход в панель</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Кейсы, блог и каталог услуг сайта it-optimization.ru.
          </p>

          <label className="mt-6 block text-sm font-medium">
            Почта
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="border-border focus:border-foreground mt-1.5 h-11 w-full rounded-lg border px-3 text-base outline-none"
            />
          </label>

          <label className="mt-4 block text-sm font-medium">
            Пароль
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="border-border focus:border-foreground mt-1.5 h-11 w-full rounded-lg border px-3 text-base outline-none"
            />
          </label>

          {errorNote}

          <button
            type="submit"
            disabled={busy}
            className="bg-foreground text-background hover:bg-accent hover:text-accent-foreground mt-6 inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Войти
          </button>
        </form>
      )}
    </div>
  );
}

function TokenGate({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const newTokenUrl = `https://github.com/settings/personal-access-tokens/new`;

  return (
    <div className="bg-muted/40 flex min-h-screen items-center justify-center px-5 py-16">
      <div className="border-border bg-background w-full max-w-lg rounded-2xl border p-7">
        <h1 className="font-display text-xl">Панель сайта</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          Панель работает без логина: ключ доступа — твой GitHub-токен. Вставь его один
          раз, он останется в этом браузере.
        </p>

        <label className="mt-6 block text-sm">
          <span className="font-medium">Fine-grained personal access token</span>
          <input
            type="password"
            value={value}
            autoComplete="off"
            placeholder="github_pat_…"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onSubmit()}
            className="border-border bg-background focus:border-foreground mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm transition-colors outline-none"
          />
        </label>

        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim()}
          className="bg-foreground text-background hover:bg-accent hover:text-accent-foreground mt-4 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-full text-sm font-medium transition-colors disabled:opacity-40"
        >
          Войти
        </button>

        <div className="border-border bg-muted/40 text-muted-foreground mt-7 space-y-2 rounded-xl border p-4 text-xs leading-relaxed">
          <p className="text-foreground font-medium">Как получить токен</p>
          <p>
            <a
              href={newTokenUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground inline-flex items-center gap-1 underline"
            >
              GitHub → Fine-grained tokens → Generate new token
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
          <p>
            Repository access — только {ADMIN_REPO.owner}/{ADMIN_REPO.repo}. Permissions →
            Repository permissions → Contents: <b>Read and write</b>. Больше ничего
            выдавать не нужно.
          </p>
          <p className="text-amber-700">
            Токен хранится в localStorage этого браузера. На чужом или общем устройстве
            после работы нажимай «Выйти» — иначе доступ к репозиторию останется у того,
            кто сядет за этот компьютер.
          </p>
        </div>
      </div>
    </div>
  );
}
