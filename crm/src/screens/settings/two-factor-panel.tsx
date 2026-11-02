import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  twoFactorApi,
  type TwoFactorSetup,
  type TwoFactorStatus,
} from "@/api/two-factor";
import { isAdmin, useAuth, useCurrentUser } from "@/auth/auth-context";
import { Badge, Button, Card, ErrorNote, Field, Input } from "@/components/ui";
import { formatDate } from "@/lib/dates";

/**
 * Подключение 2FA. Шагов несколько, и каждый живёт в `step`: секрет и коды
 * восстановления показываются ровно один раз и только в состоянии этого компонента.
 *
 * Панель видят все, включая сотрудника: 2FA защищает вход, а не только пароли.
 */
type Step =
  | { name: "idle" }
  | { name: "password" }
  | { name: "scan"; setup: TwoFactorSetup }
  | { name: "codes"; codes: string[] }
  | { name: "regenerate" }
  | { name: "disable" };

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

export function TwoFactorPanel({ onEnabled }: { onEnabled: () => void }) {
  const { refreshUser } = useAuth();
  // Лаймовая кнопка одна на экран: у админа это «Новый сотрудник» в «Команде».
  const admin = isAdmin(useCurrentUser());
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    twoFactorApi
      .status()
      .then(setStatus)
      .catch((cause: unknown) => setError(errorText(cause, "Не удалось загрузить")));
  }, []);

  useEffect(load, [load]);

  function go(next: Step) {
    setStep(next);
    setPassword("");
    setCode("");
    setError(null);
  }

  /** Общая обвязка шагов: ошибка остаётся на том же шаге, чтобы поправить ввод. */
  async function attempt(action: () => Promise<void>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setCode("");
      setError(errorText(cause, fallback));
      // Подключение сброшено на сервере: код вводить не к чему, нужен пароль.
      if (cause instanceof ApiError && cause.code === "setup_reset") {
        setStep({ name: "password" });
      }
    } finally {
      setBusy(false);
    }
  }

  function startSetup(event: FormEvent) {
    event.preventDefault();
    void attempt(async () => {
      const setup = await twoFactorApi.setup(password);
      go({ name: "scan", setup });
    }, "Не удалось начать подключение");
  }

  function confirmSetup(event: FormEvent) {
    event.preventDefault();
    void attempt(async () => {
      const { recoveryCodes } = await twoFactorApi.enable(code.trim());
      go({ name: "codes", codes: recoveryCodes });
      load();
      onEnabled();
      // Баннер снимается здесь, а не на «Я сохранил»: человек может и не нажать.
      await refreshUser();
    }, "Не удалось включить");
  }

  function regenerate(event: FormEvent) {
    event.preventDefault();
    void attempt(async () => {
      const { recoveryCodes } = await twoFactorApi.regenerateCodes(code.trim());
      go({ name: "codes", codes: recoveryCodes });
      load();
    }, "Не удалось выпустить коды");
  }

  function disable(event: FormEvent) {
    event.preventDefault();
    void attempt(async () => {
      await twoFactorApi.disable(password, code.trim());
      go({ name: "idle" });
      load();
      await refreshUser();
    }, "Не удалось отключить");
  }

  /** Секрет стирается сразу. Сбой здесь не страшен: у подключения есть срок. */
  function cancelSetup() {
    twoFactorApi.cancelSetup().catch(() => {});
    go({ name: "idle" });
  }

  const cancel = (
    <Button type="button" variant="ghost" onClick={() => go({ name: "idle" })}>
      Отмена
    </Button>
  );

  const errorNote = error && (
    <div className="mt-4">
      <ErrorNote>{error}</ErrorNote>
    </div>
  );

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[17px] leading-6 font-bold tracking-tight">
          Двухфакторный вход
        </h2>
        {status?.enabled && (
          <Badge tone="success">
            <Check size={15} strokeWidth={2.5} />
            Включён{status.enabledAt ? ` с ${formatDate(status.enabledAt)}` : ""}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        При входе, кроме пароля, нужен код из приложения: Google Authenticator, Яндекс
        Ключ, 1Password.
        {/* Доступов сотрудник не видит, и упоминать их при нём незачем. */}
        {admin && " Без него пароли в Доступах не открываются."}
      </p>

      {status && !status.available && (
        <p className="text-muted-foreground mt-4 text-sm">
          На сервере не задан ключ шифрования, поэтому подключить 2FA пока нельзя.
        </p>
      )}

      {step.name === "idle" && (
        <>
          {status?.enabled && (
            <div className="mt-4 space-y-3">
              <p className="text-muted-foreground text-sm">
                Кодов восстановления осталось: {status.recoveryCodesLeft}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => go({ name: "regenerate" })}
                  disabled={!status.available}
                >
                  Новые коды восстановления
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => go({ name: "disable" })}
                >
                  Отключить
                </Button>
              </div>
            </div>
          )}

          {status && !status.enabled && status.available && (
            <div className="mt-4">
              <Button
                variant={admin ? "secondary" : "primary"}
                onClick={() => go({ name: "password" })}
              >
                Подключить
              </Button>
            </div>
          )}

          {errorNote}
        </>
      )}

      {step.name === "password" && (
        <form onSubmit={startSetup} className="mt-4 max-w-sm">
          <Field label="Пароль от CRM">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </Field>
          {errorNote}
          <div className="mt-4 flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Проверяем…" : "Дальше"}
            </Button>
            {cancel}
          </div>
        </form>
      )}

      {step.name === "scan" && (
        <form onSubmit={confirmSetup} className="mt-4">
          <p className="text-muted-foreground text-sm">
            После включения другие входы завершатся, а телеграм надо будет подключить
            заново.
          </p>
          <p className="mt-3 text-sm">Отсканируйте код в приложении:</p>
          {/* Белая подложка обязательна: на тёмной теме QR не читается. */}
          <img
            src={`data:image/svg+xml;base64,${btoa(step.setup.qrSvg)}`}
            alt="QR-код для приложения"
            className="mt-3 size-48 rounded-lg bg-white p-2"
          />
          <p className="text-muted-foreground mt-3 text-sm">
            Не сканируется — введите ключ вручную:
          </p>
          <code className="bg-muted mt-1.5 block rounded-lg px-3 py-2.5 font-mono text-sm break-all">
            {step.setup.secret}
          </code>
          <div className="mt-4 max-w-sm">
            <Field label="Код из приложения">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
              />
            </Field>
          </div>
          {errorNote}
          <div className="mt-4 flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Проверяем…" : "Включить"}
            </Button>
            <Button type="button" variant="ghost" onClick={cancelSetup}>
              Отмена
            </Button>
          </div>
        </form>
      )}

      {step.name === "codes" && (
        <RecoveryCodes codes={step.codes} onDone={() => go({ name: "idle" })} />
      )}

      {step.name === "regenerate" && (
        <form onSubmit={regenerate} className="mt-4 max-w-sm">
          <Field
            label="Код из приложения"
            hint="Старые коды восстановления перестанут работать"
          >
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
            />
          </Field>
          {errorNote}
          <div className="mt-4 flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Выпускаем…" : "Выпустить"}
            </Button>
            {cancel}
          </div>
        </form>
      )}

      {step.name === "disable" && (
        <form onSubmit={disable} className="mt-4 max-w-sm space-y-4">
          <Field label="Пароль от CRM">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </Field>
          <Field label="Код" hint="Из приложения или код восстановления">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              autoComplete="one-time-code"
            />
          </Field>
          {errorNote}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? "Отключаем…" : "Отключить"}
            </Button>
            {cancel}
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * Коды показываются один раз: в базе остаётся только хэш. Поэтому уйти с этого шага
 * можно только явным «Я сохранил».
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер закрыт настройками браузера: коды видны на экране, перепишут руками.
    }
  }

  return (
    <div className="mt-4">
      <p className="text-sm font-medium">Сохраните коды восстановления</p>
      <p className="text-muted-foreground mt-1 text-sm">
        Каждый срабатывает один раз и заменяет код из приложения, если телефона нет под
        рукой. Больше мы их не покажем.
      </p>
      <ul className="bg-muted mt-3 grid gap-x-6 gap-y-1 rounded-lg px-3 py-2.5 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-4 flex items-center gap-2">
        <Button type="button" variant="secondary" onClick={() => void copy()}>
          {copied ? (
            <Check size={15} strokeWidth={2.5} className="text-success" />
          ) : (
            <Copy size={15} strokeWidth={2.25} />
          )}
          Скопировать
        </Button>
        <Button type="button" onClick={onDone}>
          Я сохранил
        </Button>
      </div>
    </div>
  );
}
