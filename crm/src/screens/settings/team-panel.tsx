import { Plus } from "lucide-react";
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
import { PersonChip } from "@/components/person-chip";
import { useSecondFactor } from "@/components/two-factor-prompt";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  LoadingRows,
  Modal,
  Select,
} from "@/components/ui";
import { formatDate } from "@/lib/dates";
import { forgetHandles } from "@/lib/handles";

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
  /** Учётки заводят редко, поэтому форма свёрнута и не отодвигает список. */
  const [adding, setAdding] = useState(false);
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
        setAdding(false);
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

  const errorNote = error && (
    <div className="mt-4">
      <ErrorNote>{error}</ErrorNote>
    </div>
  );

  return (
    <>
      {/* Ники раньше учёток: владелец заполняет их первым делом, а учётки меняются редко. */}
      <HandlesForm />

      <Card className="p-5">
        <h2 className="text-[17px] leading-6 font-bold tracking-tight">Команда</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Отключение закрывает вход, но не убирает человека из телеграм-чата команды: это
          делается руками.
        </p>

        {!adding && errorNote}

        {accounts === null && !error && (
          <div className="mt-3">
            <LoadingRows rows={2} />
          </div>
        )}

        {accounts && (
          <ul className="divide-border mt-2 divide-y">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                self={account.id === currentUser.id}
                onToggle={() => askToggle(account)}
              />
            ))}
          </ul>
        )}

        {adding ? (
          <form onSubmit={askCreate} className="mt-5">
            <h3 className="text-[15px] font-bold tracking-tight">Новая учётка</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field label="Имя">
                <Input
                  value={form.name}
                  onChange={(event) => setField("name", event.target.value)}
                  required
                  autoFocus
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
                  ariaLabel="Роль"
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
            {errorNote}
            <div className="mt-4 flex items-center gap-2">
              <Button type="submit" variant="secondary">
                Создать учётку
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Отмена
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-muted-foreground hover:text-foreground mt-3 flex items-center gap-1.5 text-[13px] font-semibold transition"
          >
            <Plus size={15} strokeWidth={2.5} />
            Новая учётка
          </button>
        )}

        {pendingAction && (
          <ConfirmDialog action={pendingAction} onClose={() => setPendingAction(null)} />
        )}
        {prompt}
      </Card>
    </>
  );
}

/**
 * На телефоне значки уходят второй строкой под имя, а на широком экране через `contents`
 * становятся колонками общей сетки: так роли и даты стоят друг под другом.
 */
function AccountRow({
  account,
  self,
  onToggle,
}: {
  account: Account;
  self: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_5.75rem_4rem_6.25rem_5.75rem]">
      <PersonChip name={account.name ?? account.email} className="size-8 text-[13px]" />

      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">
            {account.name ?? account.email}
          </span>
          {account.disabledAt && <Badge tone="danger">отключена</Badge>}
        </span>
        {account.name && (
          <span className="text-muted-foreground block truncate text-[13px] font-medium">
            {account.email}
          </span>
        )}
      </span>

      <span className="col-start-2 row-start-2 flex flex-wrap items-center gap-1.5 sm:contents">
        <Badge className="justify-self-start">{ROLE_LABELS[account.role]}</Badge>
        <Badge
          tone={account.twoFactorEnabled ? "success" : "neutral"}
          className="justify-self-start"
        >
          {account.twoFactorEnabled ? "2FA" : "без 2FA"}
        </Badge>
        <span className="text-muted-foreground text-[13px] font-medium whitespace-nowrap">
          {account.lastLoginAt ? `вход ${formatDate(account.lastLoginAt)}` : "не входил"}
        </span>
      </span>

      <Button
        type="button"
        size="sm"
        variant={account.disabledAt ? "secondary" : "danger"}
        onClick={onToggle}
        disabled={self}
        title={self ? "Свою учётку отключить нельзя" : undefined}
        className="col-start-3 row-span-2 row-start-1 justify-self-end sm:col-start-auto sm:row-span-1 sm:row-start-auto"
      >
        {account.disabledAt ? "Включить" : "Отключить"}
      </Button>
    </li>
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

        <div className="mt-6">
          <Button type="submit" disabled={busy} className="h-11 w-full">
            {busy ? "Проверяем…" : "Подтвердить"}
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
      forgetHandles();
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={handleSubmit}>
        <h2 className="text-[17px] leading-6 font-bold tracking-tight">Telegram-ники</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Без ника бот не сможет отметить человека в общем чате: напишет только имя.
        </p>

        {handles === null && !error && (
          <div className="mt-3">
            <LoadingRows rows={4} />
          </div>
        )}

        {handles && (
          <ul className="divide-border mt-2 divide-y">
            {handles.map((item) => (
              <li key={item.name} className="flex items-center gap-3 py-2">
                <PersonChip name={item.name} className="size-8 text-[13px]" />
                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                  {item.name}
                </span>
                <Input
                  value={item.telegramUsername ?? ""}
                  onChange={(event) => change(item.name, event.target.value)}
                  placeholder="@nickname"
                  aria-label={`Ник: ${item.name}`}
                  maxLength={33}
                  autoComplete="off"
                  className="w-40 sm:w-64"
                />
              </li>
            ))}
          </ul>
        )}

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" disabled={busy || !handles}>
            {busy ? "Сохраняем…" : "Сохранить ники"}
          </Button>
          {saved && <span className="text-success text-sm font-medium">Сохранено</span>}
        </div>
      </form>
    </Card>
  );
}
