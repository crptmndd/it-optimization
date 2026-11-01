import { Check, Send } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { BOT_USERNAME, telegramApi, type TelegramStatus } from "@/api/telegram";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { useCurrentUser } from "@/auth/auth-context";
import { TeamPanel } from "./settings/team-panel";
import { TwoFactorPanel } from "./settings/two-factor-panel";

export function SettingsScreen() {
  const user = useCurrentUser();
  // Сводка бота — про проекты, задачи и деньги; маркетолог их не видит.
  const canUseBot = user.role !== "marketing";
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** Код выдаётся только по паролю: куки мало, чат читает сводку мимо сессий. */
  const [askingPassword, setAskingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    if (!canUseBot) return;
    telegramApi
      .status()
      .then(setStatus)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, [canUseBot]);

  useEffect(load, [load]);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const issued = await telegramApi.requestCode(password);
      setCode(issued.code);
      setAskingPassword(false);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось получить код");
    } finally {
      setPending(false);
    }
  }

  async function unlink() {
    setError(null);
    setPending(true);
    try {
      await telegramApi.unlink();
      setCode(null);
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось отключить");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="max-w-2xl">
      <h1 className="text-xl font-bold tracking-tight">Настройки</h1>
      <p className="text-muted-foreground mt-1 text-sm">{user.email}</p>

      {/* Включение 2FA снимает привязку телеграма и выданный код: блок ниже устарел. */}
      <TwoFactorPanel
        onEnabled={() => {
          setCode(null);
          load();
        }}
      />

      {canUseBot && (
        <div className="border-border mt-6 rounded-xl border p-5">
          <div className="flex items-start gap-3">
            <Send size={18} className="mt-0.5 shrink-0" strokeWidth={2} />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">Напоминания в телеграме</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Каждое утро бот присылает просроченные задачи, деньги и продления и то,
                что запланировано на сегодня. Если присылать нечего — молчит.
              </p>

              {error && (
                <div className="mt-4">
                  <ErrorNote>{error}</ErrorNote>
                </div>
              )}

              {status && !status.available && (
                <p className="text-muted-foreground mt-4 text-sm">
                  Бот не настроен на сервере — подключать пока нечего.
                </p>
              )}

              {status?.available && status.connected && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <span className="text-success inline-flex items-center gap-1.5 text-sm font-medium">
                    <Check size={16} strokeWidth={2.5} />
                    Подключено
                  </span>
                  <Button
                    variant="danger"
                    onClick={() => void unlink()}
                    disabled={pending}
                  >
                    Отключить
                  </Button>
                </div>
              )}

              {status?.available && !status.connected && (
                <div className="mt-4">
                  {askingPassword && !code ? (
                    <form
                      onSubmit={(event) => void requestCode(event)}
                      className="max-w-sm"
                    >
                      <Field
                        label="Пароль от CRM"
                        hint="Привязанный чат видит сводку без входа в CRM"
                      >
                        <Input
                          type="password"
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          required
                          autoFocus
                          autoComplete="current-password"
                        />
                      </Field>
                      <div className="mt-4 flex items-center gap-2">
                        <Button type="submit" disabled={pending}>
                          {pending ? "Готовим код…" : "Получить код"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setAskingPassword(false);
                            setPassword("");
                            setError(null);
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    </form>
                  ) : code ? (
                    <div className="space-y-3">
                      <p className="text-sm">
                        Отправьте боту{" "}
                        <a
                          href={`https://t.me/${BOT_USERNAME}?start=${code}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold underline underline-offset-2"
                        >
                          @{BOT_USERNAME}
                        </a>{" "}
                        команду с этим кодом:
                      </p>
                      <code className="bg-muted block rounded-lg px-3 py-2.5 font-mono text-sm">
                        /start {code}
                      </code>
                      <p className="text-muted-foreground text-sm">
                        Код действует 15 минут. Ссылка выше подставит его сама — после
                        отправки обновите страницу.
                      </p>
                      <Button variant="ghost" onClick={load}>
                        Проверить подключение
                      </Button>
                    </div>
                  ) : (
                    <Button onClick={() => setAskingPassword(true)}>
                      Подключить телеграм
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {user.role === "owner" && <TeamPanel />}
    </section>
  );
}
