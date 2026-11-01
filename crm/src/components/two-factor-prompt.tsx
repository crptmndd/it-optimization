import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import { revealCredential, type RevealedPassword } from "@/api/credentials";
import { Button, ErrorNote, Field, Input, Modal } from "@/components/ui";

/**
 * Второй фактор для действий внутри сессии: просмотр паролей, их перенос, «Команда».
 *
 * Действие сначала идёт без кода: при открытом окне подтверждения он не нужен, и
 * человек не должен вводить его заново десять минут подряд. Сервер сам говорит, чего
 * не хватает, а хук спрашивает и повторяет то же действие.
 */

interface Waiting {
  kind: "code" | "setup";
  submit: (code: string) => Promise<void>;
  cancel: () => void;
}

export function useSecondFactor(): {
  /** `null` — человек передумал. Остальные ошибки бросаются как обычно. */
  withCode: <T>(action: (code?: string) => Promise<T>) => Promise<T | null>;
  /** Вставляется в разметку последним: окно должно лечь поверх остальных. */
  prompt: ReactNode;
} {
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  const withCode = useCallback(
    <T,>(action: (code?: string) => Promise<T>) =>
      new Promise<T | null>((resolve, reject) => {
        function finish(value: T | null) {
          setWaiting(null);
          resolve(value);
        }

        action().then(resolve, (cause: unknown) => {
          const code = cause instanceof ApiError ? cause.code : undefined;
          if (code === "code_required") {
            setWaiting({
              kind: "code",
              submit: async (value) => finish(await action(value)),
              cancel: () => finish(null),
            });
          } else if (code === "two_factor_required") {
            setWaiting({
              kind: "setup",
              submit: async () => {},
              cancel: () => finish(null),
            });
          } else {
            reject(cause);
          }
        });
      }),
    [],
  );

  return { withCode, prompt: waiting && <TwoFactorPrompt waiting={waiting} /> };
}

/** Просмотр пароля. Результат живёт только в состоянии того, кто его попросил. */
export function useRevealPassword() {
  const { withCode, prompt } = useSecondFactor();
  const reveal = useCallback(
    (id: string): Promise<RevealedPassword | null> =>
      withCode((code) => revealCredential(id, code)),
    [withCode],
  );
  return { reveal, prompt };
}

export type RevealPassword = ReturnType<typeof useRevealPassword>["reveal"];

function TwoFactorPrompt({ waiting }: { waiting: Waiting }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { cancel } = waiting;

  // Окно открывается поверх карточки, а Escape слышат оба. Перехват на фазе захвата
  // закрывает только верхнее: иначе вместе с ним ушла бы карточка с несохранённой правкой.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      cancel();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  if (waiting.kind === "setup") {
    return (
      <Modal title="Нужен двухфакторный вход" onClose={cancel}>
        <p className="text-muted-foreground max-w-prose text-sm">
          Без него пароли не открываются. Подключение занимает минуту.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <Link
            to="/settings"
            className="bg-surface text-surface-foreground rounded-lg px-3.5 py-2 text-sm font-semibold transition hover:opacity-90"
          >
            Открыть Настройки
          </Link>
          <Button type="button" variant="ghost" onClick={cancel}>
            Отмена
          </Button>
        </div>
      </Modal>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await waiting.submit(code.trim());
    } catch (cause) {
      setCode("");
      setError(cause instanceof ApiError ? cause.message : "Не получилось проверить код");
      setBusy(false);
    }
  }

  return (
    <Modal title="Код подтверждения" onClose={cancel}>
      <form onSubmit={handleSubmit}>
        <Field
          label="Шесть цифр из приложения"
          hint="После этого 10 минут пароли открываются без кода"
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

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Проверяем…" : "Подтвердить"}
          </Button>
          <Button type="button" variant="ghost" onClick={cancel}>
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
