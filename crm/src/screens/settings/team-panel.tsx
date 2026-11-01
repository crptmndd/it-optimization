import { Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  createAccount,
  listAccounts,
  listHandles,
  saveHandles,
  setAccountDisabled,
  type Account,
  type AccountInput,
  type OwnerConfirm,
  type TeamHandle,
} from "@/api/team";
import { useCurrentUser, type UserRole } from "@/auth/auth-context";
import { useSecondFactor } from "@/components/two-factor-prompt";
import { Badge, Button, ErrorNote, Field, Input, Modal, Select } from "@/components/ui";
import { formatDate } from "@/lib/dates";

/**
 * Команда: учётки и Telegram-ники. Только у владельца, и запрет стоит на сервере.
 *
 * Каждое изменение учёток подтверждается паролем владельца, а при включённой 2FA ещё и
 * кодом: иначе украденной куки хватило бы, чтобы завести свою учётку. Смены роли и
 * пароля здесь нет намеренно: это делает `user:create` на сервере.
 */

const ROLE_LABELS: Record<UserRole, string> = {
  owner: "Владелец",
  editor: "Редактор",
  marketing: "Маркетолог",
};

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as UserRole[]).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));

const MIN_PASSWORD_LENGTH = 12;

function emptyAccount(): AccountInput {
  return { email: "", name: "", role: "editor", password: "" };
}

/** Что подтверждается: окно одно на создание и на отключение. */
interface PendingAction {
  title: string;
  note: string;
  run: (confirm: OwnerConfirm) => Promise<void>;
}

export function TeamPanel() {
  const currentUser = useCurrentUser();
  const { withCode, prompt } = useSecondFactor();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [form, setForm] = useState<AccountInput>(emptyAccount);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listAccounts()
      .then(setAccounts)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, []);

  useEffect(load, [load]);

  function setField<K extends keyof AccountInput>(key: K, value: AccountInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function askCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
      return;
    }
    const input = form;
    setPendingAction({
      title: "Новая учётка",
      note: `Создаём ${input.email} (${ROLE_LABELS[input.role].toLowerCase()}).`,
      run: async (confirm) => {
        const created = await withCode((code) =>
          createAccount(input, { ...confirm, code }),
        );
        if (!created) return;
        setForm(emptyAccount());
        setPendingAction(null);
        load();
      },
    });
  }

  function askToggle(account: Account) {
    const disabled = account.disabledAt === null;
    setError(null);
    setPendingAction({
      title: disabled ? "Отключить учётку" : "Включить учётку",
      note: disabled
        ? `${account.email} потеряет все открытые сессии и не сможет войти.`
        : `${account.email} снова сможет войти. Старые сессии не вернутся.`,
      run: async (confirm) => {
        const changed = await withCode((code) =>
          setAccountDisabled(account.id, disabled, { ...confirm, code }),
        );
        if (!changed) return;
        setPendingAction(null);
        load();
      },
    });
  }

  return (
    <div className="border-border mt-6 rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <Users size={18} className="mt-0.5 shrink-0" strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Команда</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Отключение закрывает вход, но не убирает человека из телеграм-чата команды:
            это делается руками.
          </p>

          {error && (
            <div className="mt-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <ul className="mt-4 space-y-2">
            {accounts?.map((account) => (
              <li
                key={account.id}
                className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2"
              >
                <span className="min-w-0 flex-1 basis-48">
                  <span className="block truncate text-sm font-medium">
                    {account.name ?? account.email}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {[
                      account.name && account.email,
                      ROLE_LABELS[account.role],
                      account.lastLoginAt
                        ? `вход ${formatDate(account.lastLoginAt)}`
                        : "не входил",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <Badge tone={account.twoFactorEnabled ? "success" : "neutral"}>
                  {account.twoFactorEnabled ? "2FA" : "без 2FA"}
                </Badge>
                {account.disabledAt && <Badge tone="danger">отключена</Badge>}
                <Button
                  type="button"
                  variant={account.disabledAt ? "ghost" : "danger"}
                  onClick={() => askToggle(account)}
                  disabled={account.id === currentUser.id}
                  title={
                    account.id === currentUser.id
                      ? "Свою учётку отключить нельзя"
                      : undefined
                  }
                >
                  {account.disabledAt ? "Включить" : "Отключить"}
                </Button>
              </li>
            ))}
          </ul>

          <form onSubmit={askCreate} className="mt-6">
            <h3 className="text-sm font-semibold">Новая учётка</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Имя">
                <Input
                  value={form.name}
                  onChange={(event) => setField("name", event.target.value)}
                  required
                  maxLength={120}
                  autoComplete="off"
                />
              </Field>
              <Field label="Почта">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => setField("email", event.target.value)}
                  required
                  autoComplete="off"
                />
              </Field>
              <Field label="Роль">
                <Select
                  value={form.role}
                  onChange={(role) => setField("role", role as UserRole)}
                  options={ROLE_OPTIONS}
                />
              </Field>
              <Field
                label="Пароль"
                hint={`Не короче ${MIN_PASSWORD_LENGTH} символов. Передайте человеку лично`}
              >
                <Input
                  type="password"
                  value={form.password}
                  onChange={(event) => setField("password", event.target.value)}
                  required
                  maxLength={200}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <div className="mt-4">
              <Button type="submit">Создать учётку</Button>
            </div>
          </form>

          <HandlesForm />
        </div>
      </div>

      {pendingAction && (
        <ConfirmDialog action={pendingAction} onClose={() => setPendingAction(null)} />
      )}
      {prompt}
    </div>
  );
}

function ConfirmDialog({
  action,
  onClose,
}: {
  action: PendingAction;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await action.run({ password });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={action.title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <p className="text-muted-foreground max-w-prose text-sm">{action.note}</p>
        <div className="mt-4">
          <Field label="Ваш пароль от CRM">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Проверяем…" : "Подтвердить"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const HANDLE_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/;

/**
 * Ники исполнителей: по ним бот тэгает людей в общем чате. Ключ — имя из списка
 * исполнителей, а не учётка: человек может вести задачи и без своего входа.
 */
function HandlesForm() {
  const [handles, setHandles] = useState<TeamHandle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listHandles()
      .then(setHandles)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, []);

  function change(name: string, telegramUsername: string) {
    setSaved(false);
    setHandles(
      (current) =>
        current?.map((item) =>
          item.name === name ? { ...item, telegramUsername } : item,
        ) ?? null,
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!handles) return;
    setError(null);
    setSaved(false);

    // Сервер отвечает общим «некорректные данные», а человеку нужно знать, чей ник.
    const wrong = handles.find(
      (item) =>
        item.telegramUsername?.trim() &&
        !HANDLE_PATTERN.test(item.telegramUsername.trim()),
    );
    if (wrong) {
      setError(`${wrong.name}: ник — от 5 до 32 латинских букв, цифр или подчёркиваний`);
      return;
    }

    setBusy(true);
    try {
      setHandles(await saveHandles(handles));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6">
      <h3 className="text-sm font-semibold">Telegram-ники</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        Бот тэгает исполнителя в общем чате. Нет ника — напишет имя жирным.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {handles?.map((item) => (
          <Field key={item.name} label={item.name}>
            <Input
              value={item.telegramUsername ?? ""}
              onChange={(event) => change(item.name, event.target.value)}
              placeholder="@nickname"
              maxLength={33}
              autoComplete="off"
            />
          </Field>
        ))}
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button type="submit" variant="ghost" disabled={busy || !handles}>
          {busy ? "Сохраняем…" : "Сохранить ники"}
        </Button>
        {saved && <span className="text-success text-sm font-medium">Сохранено</span>}
      </div>
    </form>
  );
}
