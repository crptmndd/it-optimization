import { Check, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  createAccount,
  listAccounts,
  listHandles,
  saveHandles,
  setAccountDisabled,
  setAccountRole,
  type Account,
  type AccountInput,
  type AdminConfirm,
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
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { useFocusFromLink } from "@/lib/focus-card";
import { forgetPeople } from "@/lib/people";

/**
 * Команда: один список людей с учёткой, ролью и Telegram-ником. Только у админа, и
 * запрет стоит на сервере.
 *
 * Список строится от людей, а не от учёток: исполнителем бывает и тот, у кого входа
 * нет, и здесь же ему этот вход заводят. Учётка без человека тоже показывается, иначе
 * её нельзя было бы отключить.
 *
 * Каждое изменение учёток подтверждается паролем админа, а при включённой 2FA ещё и
 * кодом: иначе украденной куки хватило бы, чтобы завести свою учётку или поднять себе
 * роль. Ник подтверждения не просит: доступа он не даёт. Смены пароля здесь нет
 * намеренно: это делает `user:create` на сервере.
 */

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Админ",
  employee: "Сотрудник",
};

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as UserRole[]).map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));

/** Что роль меняет на деле: окно подтверждения говорит об этом до нажатия. */
const ROLE_EFFECT: Record<UserRole, string> = {
  admin: "станет админом: увидит всех людей, деньги и Доступы",
  employee: "станет сотрудником: будет видеть только свои задачи и проекты, без денег",
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const MIN_PASSWORD_LENGTH = 12;

const HANDLE_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const HANDLE_RULE = "Ник — от 5 до 32 латинских букв, цифр или подчёркиваний";

/** Сколько висит «Сохранено». Подпись лежит поверх поля и не должна мешать его читать. */
const SAVED_NOTE_MS = 2200;

function cleanHandle(value: string): string {
  return value.trim().replace(/^@/, "");
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Что подтверждается: окно одно на отключение и смену роли. */
interface PendingAction {
  title: string;
  note: string;
  run: (confirm: AdminConfirm) => Promise<void>;
}

/** Чем заполнить форму учётки. `locked` — вход заводят уже известному человеку. */
interface AccountPreset {
  name: string;
  telegramUsername: string;
  locked: boolean;
}

const NEW_PERSON: AccountPreset = { name: "", telegramUsername: "", locked: false };

interface TeamRow {
  /** Имя в команде, ключ для ника. `null` у учётки, которая ни с кем не связана. */
  person: string | null;
  telegramUsername: string | null;
  account: Account | null;
}

function buildRows(handles: TeamHandle[], accounts: Account[]): TeamRow[] {
  const people = new Set(handles.map((item) => item.name));
  const rows: TeamRow[] = [
    ...handles.map((item) => ({
      person: item.name,
      telegramUsername: item.telegramUsername,
      account: accounts.find((account) => account.memberName === item.name) ?? null,
    })),
    ...accounts
      .filter((account) => !account.memberName || !people.has(account.memberName))
      .map((account) => ({ person: null, telegramUsername: null, account })),
  ];
  // Отключённые вниз, порядок внутри групп сохраняется: `sort` устойчивая.
  return rows.sort(
    (a, b) =>
      Number(Boolean(a.account?.disabledAt)) - Number(Boolean(b.account?.disabledAt)),
  );
}

function rowTitle({ person, account }: TeamRow): string {
  return account?.name ?? person ?? account?.email ?? "";
}

export function TeamPanel() {
  const currentUser = useCurrentUser();
  const { withCode, prompt } = useSecondFactor();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [handles, setHandles] = useState<TeamHandle[] | null>(null);
  const [preset, setPreset] = useState<AccountPreset | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([listAccounts(), listHandles()])
      .then(([nextAccounts, nextHandles]) => {
        setAccounts(nextAccounts);
        setHandles(nextHandles);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, []);

  useEffect(load, [load]);

  // Сюда ведёт «Указать» из формы задачи. Ждём список: пока он грузится, карточка
  // низкая, и прокрутка привела бы не туда.
  useFocusFromLink(accounts !== null && handles !== null);

  /**
   * Из ответа берём только своего человека. В нём снимок всей команды, и снимок, пришедший
   * позже соседнего, вернул бы старый ник в строку, где только что сохранили новый.
   */
  const handleSaved = useCallback((fresh: TeamHandle) => {
    setHandles(
      (list) => list?.map((item) => (item.name === fresh.name ? fresh : item)) ?? list,
    );
  }, []);

  /** Состав поменялся: следующая форма задачи должна видеть его без перезагрузки. */
  const changed = useCallback(() => {
    forgetPeople();
    load();
  }, [load]);

  function askToggle(account: Account) {
    const disabled = account.disabledAt === null;
    setError(null);
    setPendingAction({
      title: disabled ? "Отключить учётку" : "Включить учётку",
      note: disabled
        ? `${account.email} потеряет все открытые сессии и не сможет войти.`
        : `${account.email} снова сможет войти. Старые сессии не вернутся.`,
      run: async (confirm) => {
        const done = await withCode((code) =>
          setAccountDisabled(account.id, disabled, { ...confirm, code }),
        );
        if (!done) return;
        setPendingAction(null);
        changed();
      },
    });
  }

  function askRole(account: Account, role: UserRole) {
    if (role === account.role) return;
    const who = account.name ?? account.email;
    setError(null);
    setPendingAction({
      title: "Сменить роль",
      note: `${who} ${ROLE_EFFECT[role]}. Действует сразу, без нового входа.`,
      run: async (confirm) => {
        const done = await withCode((code) =>
          setAccountRole(account.id, role, { ...confirm, code }),
        );
        if (!done) return;
        setPendingAction(null);
        changed();
      },
    });
  }

  const rows = accounts && handles ? buildRows(handles, accounts) : null;

  return (
    <div data-card-id="team" className="rounded-2xl">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="max-w-prose min-w-0">
            <h2 className="text-[17px] leading-6 font-bold tracking-tight">Команда</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Без ника бот напишет в чате только имя и не отметит человека. Отключение
              закрывает вход, но не убирает из телеграм-чата: это делается руками.
            </p>
          </div>
          <Button onClick={() => setPreset(NEW_PERSON)}>
            <Plus size={17} strokeWidth={2.5} />
            Новый сотрудник
          </Button>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        {rows === null && !error && (
          <div className="mt-3">
            <LoadingRows rows={4} />
          </div>
        )}

        {rows && (
          <ul className="divide-border mt-2 divide-y">
            {rows.map((row) => (
              <PersonRow
                key={row.person ?? row.account?.id}
                row={row}
                self={row.account?.id === currentUser.id}
                onToggle={askToggle}
                onRole={askRole}
                onHandleSaved={handleSaved}
                onCreateLogin={() =>
                  setPreset({
                    name: row.person ?? "",
                    telegramUsername: row.telegramUsername ?? "",
                    locked: true,
                  })
                }
              />
            ))}
          </ul>
        )}

        {preset && (
          <AccountForm
            preset={preset}
            noLogin={handles?.filter((item) => !item.hasAccount) ?? []}
            withCode={withCode}
            onClose={() => setPreset(null)}
            onCreated={() => {
              setPreset(null);
              changed();
            }}
          />
        )}
        {pendingAction && (
          <ConfirmDialog action={pendingAction} onClose={() => setPendingAction(null)} />
        )}
        {prompt}
      </Card>
    </div>
  );
}

/**
 * Узкий экран: кружок, имя и действие в первой строке, остальное рядом под именем. С xl
 * обёртка исчезает через `contents`, и каждое поле встаёт в свою колонку общей сетки.
 * Колонки заданы явно: у человека без входа часть ячеек пуста, и соседние не должны
 * съезжать.
 */
function PersonRow({
  row,
  self,
  onToggle,
  onRole,
  onHandleSaved,
  onCreateLogin,
}: {
  row: TeamRow;
  self: boolean;
  onToggle: (account: Account) => void;
  onRole: (account: Account, role: UserRole) => void;
  onHandleSaved: (handle: TeamHandle) => void;
  onCreateLogin: () => void;
}) {
  const { account, person } = row;
  const title = rowTitle(row);

  return (
    <li className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 xl:grid-cols-[auto_minmax(0,1fr)_8.5rem_10.5rem_4.5rem_7.5rem_7.5rem]">
      <PersonChip name={person ?? title} className="size-8 text-[13px]" />

      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{title}</span>
          {account?.disabledAt && <Badge tone="danger">отключена</Badge>}
        </span>
        {account && (
          <span className="text-muted-foreground block truncate text-[13px] font-medium">
            {account.email}
          </span>
        )}
      </span>

      <span className="col-span-2 col-start-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-2 xl:contents">
        <span className="w-[8.5rem] xl:col-start-3 xl:row-start-1 xl:w-auto">
          {account ? (
            <span title={self ? "Свою роль менять нельзя" : undefined} className="block">
              <Select
                value={account.role}
                onChange={(role) => onRole(account, role as UserRole)}
                options={ROLE_OPTIONS}
                disabled={self}
                ariaLabel={`Роль: ${title}`}
                className="h-9 text-[13px]"
              />
            </span>
          ) : (
            <span className="text-muted-foreground text-[13px] font-medium">
              нет входа
            </span>
          )}
        </span>

        {person && (
          <HandleField
            name={person}
            value={row.telegramUsername}
            onSaved={onHandleSaved}
          />
        )}

        {account && (
          <>
            <Badge
              tone={account.twoFactorEnabled ? "success" : "neutral"}
              className="justify-self-start xl:col-start-5 xl:row-start-1"
            >
              {account.twoFactorEnabled ? "2FA" : "без 2FA"}
            </Badge>
            <span className="text-muted-foreground text-[13px] font-medium whitespace-nowrap xl:col-start-6 xl:row-start-1">
              {account.lastLoginAt
                ? `вход ${formatDate(account.lastLoginAt)}`
                : "входа не было"}
            </span>
          </>
        )}
      </span>

      <span className="col-start-3 row-start-1 flex justify-end xl:col-start-7">
        {account ? (
          <Button
            type="button"
            size="sm"
            variant={account.disabledAt ? "secondary" : "danger"}
            onClick={() => onToggle(account)}
            disabled={self}
            title={self ? "Свою учётку отключить нельзя" : undefined}
          >
            {account.disabledAt ? "Включить" : "Отключить"}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={onCreateLogin}>
            Создать вход
          </Button>
        )}
      </span>
    </li>
  );
}

/**
 * Ник прямо в строке: сохраняется по Enter и при уходе из поля. Подтверждения паролем
 * нет намеренно, ник не даёт доступа, а вписывают их обычно несколько подряд.
 *
 * Сервер меняет только присланных, поэтому уходит один человек: иначе правка в двух
 * вкладках откатывала бы соседние ники.
 */
function HandleField({
  name,
  value,
  onSaved,
}: {
  name: string;
  value: string | null;
  onSaved: (handle: TeamHandle) => void;
}) {
  const saved = value ?? "";
  const [draft, setDraft] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** Что ушло на сервер: Enter и следующий за ним уход из поля — одно сохранение. */
  const sent = useRef(saved);

  // Ник мог поменяться и без этого поля: бот заполняет пустой при привязке чата.
  useEffect(() => {
    setDraft(saved);
    sent.current = saved;
  }, [saved]);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), SAVED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  async function save() {
    const next = cleanHandle(draft);
    if (next === sent.current) {
      setDraft(next);
      setProblem(null);
      return;
    }
    if (next && !HANDLE_PATTERN.test(next)) {
      setDone(false);
      setProblem(HANDLE_RULE);
      return;
    }

    const previous = sent.current;
    sent.current = next;
    setProblem(null);
    try {
      const team = await saveHandles([{ name, telegramUsername: next || null }]);
      const fresh = team.find((item) => item.name === name);
      if (fresh) onSaved(fresh);
      forgetPeople();
      setDraft(next);
      setDone(true);
    } catch (cause) {
      sent.current = previous;
      setDone(false);
      setProblem(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    }
  }

  return (
    <>
      <span className="relative min-w-[7.5rem] flex-1 xl:col-start-4 xl:row-start-1">
        <span
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] font-medium"
        >
          @
        </span>
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
            setDone(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void save();
          }}
          onBlur={() => void save()}
          placeholder="ник"
          aria-label={`Ник: ${name}`}
          aria-invalid={problem !== null}
          maxLength={33}
          autoComplete="off"
          spellCheck={false}
          className={cn("h-9 pr-2 pl-6 text-[13px]", problem && "ring-danger ring-2")}
        />
        {done && (
          /* Поверх поля, а не строкой под ним: подпись живёт две секунды, и список не
             должен прыгать вверх-вниз, пока ники вписывают подряд. */
          <span
            role="status"
            className="text-success bg-field pointer-events-none absolute inset-y-0 right-1 my-auto flex h-6 items-center gap-1 rounded px-1 text-xs font-semibold"
          >
            <Check size={13} strokeWidth={3} />
            Сохранено
          </span>
        )}
      </span>

      {problem && (
        <span
          role="alert"
          className="text-danger w-full text-xs font-medium xl:col-span-4 xl:col-start-4 xl:row-start-2"
        >
          {problem}
        </span>
      )}
    </>
  );
}

/**
 * Новый сотрудник и вход для уже известного человека. Имя у второго не правится: по нему
 * сервер находит человека, и другое имя завело бы нового рядом с тем, у кого есть задачи.
 *
 * Пароль админа прямо в форме, а не вторым окном: иначе после пяти полей человек ждёт
 * «Создано», а получает ещё одно окно с полем пароля.
 */
function AccountForm({
  preset,
  noLogin,
  withCode,
  onClose,
  onCreated,
}: {
  preset: AccountPreset;
  /** Люди без учётки: новое имя может оказаться одним из них. */
  noLogin: TeamHandle[];
  withCode: <T>(action: (code?: string) => Promise<T>) => Promise<T | null>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [values, setValues] = useState<AccountInput>({
    email: "",
    name: preset.name,
    role: "employee",
    password: "",
  });
  const [handle, setHandle] = useState(preset.telegramUsername);
  /** Вход заводят уже известному человеку: имя не правится. */
  const [locked, setLocked] = useState(preset.locked);
  const [adminPassword, setAdminPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof AccountInput>(key: K, value: AccountInput[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  /*
   * «Тимур Хакимов» при существующем «Тимур» сервер заведёт вторым человеком: он сравнивает
   * имена целиком, и старые задачи новому сотруднику не откроются. Угадывать здесь нельзя,
   * тёзки бывают, поэтому решает админ. Вписанное в форму при этом не теряется.
   */
  const namesake = locked
    ? undefined
    : noLogin.find(
        (person) =>
          firstWord(values.name) !== "" &&
          firstWord(person.name) === firstWord(values.name),
      );

  function pickNamesake(person: TeamHandle) {
    setLocked(true);
    set("name", person.name);
    setHandle((current) => current || (person.telegramUsername ?? ""));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!values.name.trim()) {
      setError("Укажите имя");
      return;
    }
    // Браузер пропускает `vadim@dev`, а сервер нет, и вход с таким адресом не сработал бы.
    if (!EMAIL_PATTERN.test(values.email.trim())) {
      setError("Укажите почту полностью, например name@company.ru");
      return;
    }
    if (values.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`);
      return;
    }
    const nick = cleanHandle(handle);
    if (nick && !HANDLE_PATTERN.test(nick)) {
      setError(HANDLE_RULE);
      return;
    }

    setBusy(true);
    try {
      const created = await withCode((code) =>
        createAccount(
          { ...values, telegramUsername: nick || null },
          { password: adminPassword, code },
        ),
      );
      if (created) onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось создать");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={locked ? "Создать вход" : "Новый сотрудник"} onClose={onClose}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Имя">
            <Input
              value={values.name}
              onChange={(event) => set("name", event.target.value)}
              required
              disabled={locked}
              autoFocus={!locked}
              maxLength={120}
              autoComplete="off"
            />
          </Field>
          <Field label="Почта">
            <Input
              type="email"
              value={values.email}
              onChange={(event) => set("email", event.target.value)}
              required
              autoFocus={locked}
              autoComplete="off"
            />
          </Field>
          {namesake && (
            <p className="text-warning text-xs font-medium sm:col-span-2">
              «{namesake.name}» уже в команде, без входа. Это один человек?{" "}
              <button
                type="button"
                onClick={() => pickNamesake(namesake)}
                className="font-bold underline underline-offset-2"
              >
                Создать вход
              </button>
            </p>
          )}
          <Field
            label="Пароль"
            hint={`Не короче ${MIN_PASSWORD_LENGTH} символов. Передайте человеку лично`}
          >
            <Input
              type="password"
              value={values.password}
              onChange={(event) => set("password", event.target.value)}
              required
              maxLength={200}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Роль">
            <Select
              value={values.role}
              onChange={(role) => set("role", role as UserRole)}
              options={ROLE_OPTIONS}
              ariaLabel="Роль"
            />
          </Field>
          <Field label="Telegram-ник" hint="Необязательно" className="sm:col-span-2">
            <Input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="@nickname"
              maxLength={33}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="mt-6">
          <h3 className="text-[15px] font-bold tracking-tight">Подтверждение</h3>
          <div className="mt-3">
            <Field label="Ваш пароль от CRM">
              <Input
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
          </div>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6">
          <Button type="submit" disabled={busy} className="h-11 w-full">
            {busy ? "Создаём…" : locked ? "Создать вход" : "Создать сотрудника"}
          </Button>
        </div>
      </form>
    </Modal>
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
