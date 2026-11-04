import { Check } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { BOT_USERNAME, telegramApi, type TelegramStatus } from "@/api/telegram";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  PageHeader,
} from "@/components/ui";
import { isAdmin, useCurrentUser } from "@/auth/auth-context";
import { cn } from "@/lib/cn";
import { AppearancePanel } from "./settings/appearance-panel";
import { TeamPanel } from "./settings/team-panel";
import { TwoFactorPanel } from "./settings/two-factor-panel";

export function SettingsScreen() {
  const user = useCurrentUser();
  const admin = isAdmin(user);
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  /** Код выдаётся только по паролю: куки мало, чат читает сводку мимо сессий. */
  const [askingPassword, setAskingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(() => {
    telegramApi
      .status()
      .then(setStatus)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, []);

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
    // Строке команды нужна вся ширина экрана. Личные блоки у админа встают в два столбца,
    // иначе «Команда» уезжает за первый экран; сотруднику хватает одной узкой колонки.
    <section className={admin ? undefined : "max-w-[720px]"}>
      <PageHeader title="Настройки" subtitle={user.email} />

      <div className="mt-5 space-y-6">
        <div className={cn("grid gap-6", admin && "xl:grid-cols-2")}>
          {/* Включение 2FA снимает привязку телеграма и выданный код: блок рядом устарел. */}
          <TwoFactorPanel
            onEnabled={() => {
              setCode(null);
              load();
            }}
          />

          <Card className="p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-[17px] leading-6 font-bold tracking-tight">
                Напоминания в телеграме
              </h2>
              {status?.available && status.connected && (
                <Badge tone="success">
                  <Check size={15} strokeWidth={2.5} />
                  Подключено
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {admin
                ? "Счета, сводка, новые проекты и ваши задачи приходят лично от бота, в общий чат они не попадают. Без подключения вы их не получите."
                : "Сводка и задачи идут в общий чат команды. Подключение здесь даёт команду /today в личных сообщениях с ботом."}
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
              <div className="mt-4">
                <Button
                  variant="danger"
                  size="sm"
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
                    <Button variant="secondary" size="sm" onClick={load}>
                      Проверить подключение
                    </Button>
                  </div>
                ) : (
                  <Button variant="secondary" onClick={() => setAskingPassword(true)}>
                    Подключить телеграм
                  </Button>
                )}
              </div>
            )}
          </Card>

          <AppearancePanel className={admin ? "xl:col-span-2" : undefined} />
        </div>

        {admin && <TeamPanel />}
      </div>
    </section>
  );
}
