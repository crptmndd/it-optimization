import { useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { LogoMark } from "@/components/logo-mark";
import { useAuth } from "@/auth/auth-context";
import { Button, Card, ErrorNote, Field, Input } from "@/components/ui";

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
    // Вход рисуется вне оболочки, поэтому полотно задано здесь, а не взято из `Shell`.
    <main className="bg-canvas flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm p-6 sm:p-7">
        <div className="mb-6 flex flex-col items-center text-center">
          <LogoMark className="h-9 w-auto" />
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Вход в CRM</h1>
          <p className="text-muted-foreground mt-0.5 text-sm font-medium">
            Внутренняя система «Айти-Оптимизации»
          </p>
        </div>

        {/* Разные key: иначе React переделал бы поле почты в поле кода, и autoFocus
            на втором шаге не сработал бы. */}
        {ticket ? (
          <form key="code" onSubmit={handleCode} className="space-y-4">
            <Field
              label="Код подтверждения"
              hint="Шесть цифр из приложения. Телефона нет — код восстановления."
            >
              {/* inputMode="text": подходит и код восстановления, а в нём есть буквы. */}
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="text"
                className="h-11"
              />
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" disabled={pending} className="h-11 w-full">
              {pending ? "Проверяем…" : "Войти"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => backToPassword()}
              className="w-full"
            >
              Назад
            </Button>
          </form>
        ) : (
          <form key="password" onSubmit={handlePassword} className="space-y-4">
            <Field label="Почта">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="username"
                autoFocus
                className="h-11"
              />
            </Field>

            <Field label="Пароль">
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                className="h-11"
              />
            </Field>

            {error && <ErrorNote>{error}</ErrorNote>}

            <Button type="submit" disabled={pending} className="h-11 w-full">
              {pending ? "Входим…" : "Войти"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
