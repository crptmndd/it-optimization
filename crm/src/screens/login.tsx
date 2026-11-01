import { useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { useAuth } from "@/auth/auth-context";

const inputClass =
  "border-border bg-background focus:border-accent w-full rounded-lg border px-3 py-2.5 text-sm transition outline-none";

export function LoginScreen() {
  const { login, completeTwoFactor } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /**
   * Билет между паролем и кодом. Только в состоянии компонента: ни в адрес, ни в
   * localStorage он попасть не должен.
   */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function backToPassword(message: string | null = null) {
    setTicket(null);
    setCode("");
    setError(message);
  }

  async function handlePassword(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const result = await login(email, password);
      if (result.status === "two_factor") {
        setTicket(result.ticket);
        // Пароль больше не нужен, и держать его в памяти незачем.
        setPassword("");
        setPending(false);
      }
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Не получилось войти. Попробуй ещё раз.",
      );
      setPending(false);
    }
  }

  async function handleCode(event: FormEvent) {
    event.preventDefault();
    if (!ticket) return;
    setError(null);
    setPending(true);
    try {
      await completeTwoFactor(ticket, code);
    } catch (cause) {
      setPending(false);
      // Билет живёт пять минут: дальше пароль придётся ввести заново.
      if (cause instanceof ApiError && cause.code === "ticket_expired") {
        backToPassword(cause.message);
        return;
      }
      setCode("");
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Не получилось войти. Попробуй ещё раз.",
      );
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="bg-accent mb-3 h-2 w-10 rounded-full" />
          <h1 className="text-2xl font-bold tracking-tight">CRM</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Внутренняя система «Айти-Оптимизации»
          </p>
        </div>

        {/* Разные key: иначе React переделал бы поле почты в поле кода, и autoFocus
            на втором шаге не сработал бы. */}
        {ticket ? (
          <form key="code" onSubmit={handleCode} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Код подтверждения</span>
              {/* inputMode="text": подходит и код восстановления, а в нём есть буквы. */}
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="text"
                className={inputClass}
              />
              <span className="text-muted-foreground mt-1.5 block text-sm">
                Шесть цифр из приложения. Телефона нет — код восстановления.
              </span>
            </label>

            {error && (
              <p
                role="alert"
                className="bg-danger-soft text-danger rounded-lg px-3 py-2.5 text-sm"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="bg-surface text-surface-foreground w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Проверяем…" : "Войти"}
            </button>
            <button
              type="button"
              onClick={() => backToPassword()}
              className="text-muted-foreground hover:text-foreground w-full text-sm transition"
            >
              Назад
            </button>
          </form>
        ) : (
          <form key="password" onSubmit={handlePassword} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Почта</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="username"
                autoFocus
                className={inputClass}
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">Пароль</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                className={inputClass}
              />
            </label>

            {error && (
              <p
                role="alert"
                className="bg-danger-soft text-danger rounded-lg px-3 py-2.5 text-sm"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="bg-surface text-surface-foreground w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition hover:opacity-90 disabled:opacity-50"
            >
              {pending ? "Входим…" : "Войти"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
