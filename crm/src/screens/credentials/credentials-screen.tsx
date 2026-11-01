import {
  Check,
  Copy,
  Eye,
  EyeOff,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Lock,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  updateCredential,
  type Credential,
  type CredentialInput,
} from "@/api/credentials";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  describeDeadline,
  formatDate,
  fromDateInputValue,
  nextRenewalDate,
  toDateInputValue,
} from "@/lib/dates";
import { listProjects, type Project } from "@/api/projects";
import { CurrencySelect } from "@/components/currency-select";
import { NoteHint } from "@/components/note-hint";
import {
  amountToInput,
  fee,
  parseAmount,
  sanitizeAmount,
  type Currency,
} from "@/lib/money";
import { useRevealPassword, type RevealPassword } from "@/components/two-factor-prompt";
import { LegacyMigration } from "./legacy-migration";

/**
 * Справочник учёток сервисов, включая пароли.
 *
 * Пароли шифрует сервер ключом из своего окружения, поэтому дамп базы без него ничего
 * не раскрывает. Список и карточка пароль не получают: он открывается отдельным
 * запросом с кодом 2FA, и каждый просмотр пишется в журнал.
 *
 * Отсюда правило, которое легко нарушить: открытый пароль существует только в
 * состоянии компонента, который его показывает, и в буфере обмена. Его нельзя ни
 * положить в localStorage, ни подставить в форму заранее.
 */
interface FormValues {
  service: string;
  login: string;
  url: string;
  owner: string;
  projectId: string;
  renewsDate: string;
  amount: string;
  currency: Currency;
  monthlyFee: boolean;
  /** Новый пароль. Пусто — не менять: текущий в форму не попадает никогда. */
  password: string;
  /** Стереть пароль при сохранении. Отдельно: пустое поле значит «не менять». */
  clearPassword: boolean;
  notes: string;
}

function empty(): FormValues {
  return {
    service: "",
    login: "",
    url: "",
    owner: "",
    projectId: "",
    renewsDate: "",
    amount: "",
    currency: "rub",
    monthlyFee: false,
    password: "",
    clearPassword: false,
    notes: "",
  };
}

function toValues(item: Credential): FormValues {
  return {
    service: item.service,
    login: item.login ?? "",
    url: item.url ?? "",
    owner: item.owner ?? "",
    projectId: item.project?.id ?? "",
    renewsDate: toDateInputValue(item.renewsAt),
    amount: amountToInput(item.amountMinor),
    currency: item.currency ?? "rub",
    monthlyFee: item.monthlyFee ?? false,
    password: "",
    clearPassword: false,
    notes: item.notes ?? "",
  };
}

function toInput(values: FormValues): CredentialInput {
  return {
    service: values.service.trim(),
    login: values.login.trim() || null,
    url: values.url.trim() || null,
    owner: values.owner.trim() || null,
    projectId: values.projectId || null,
    renewsAt: fromDateInputValue(values.renewsDate),
    amountMinor: parseAmount(values.amount),
    currency: values.currency,
    monthlyFee: values.monthlyFee,
    notes: values.notes.trim() || null,
    // Без trim: пробелы в пароле значимы. Поле опускается, а не шлётся пустым: иначе
    // обычное сохранение карточки стирало бы пароль.
    ...(values.clearPassword
      ? { password: null }
      : values.password && { password: values.password }),
  };
}

/** Значение фильтра для записей без проекта: пустая строка уже занята под «все». */
const NO_PROJECT = "none";

/**
 * Свёрнутые группы переживают уход с экрана.
 *
 * Иначе свернуть половину проектов и вернуться означало бы развернуть всё
 * заново — то есть смысл шторок пропадал бы при каждом переходе. Хранится
 * локально у каждого: это настройка вида, а не данные команды.
 */
const COLLAPSED_KEY = "credentials:collapsed";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Приватный режим или запрет на хранилище — просто показываем всё.
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    // Не сохранилось — не беда: развернётся при следующем заходе.
  }
}

export function CredentialsScreen() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  /** Пусто — все проекты, NO_PROJECT — записи без привязки, иначе id проекта. */
  const [projectFilter, setProjectFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  // Одно окно кода на экран: и строка, и карточка просят его одинаково.
  const { reveal, prompt } = useRevealPassword();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Проекты нужны только для выбора в карточке и заголовков групп — грузятся
  // один раз и не зависят от поиска. С архивом: сайт архивного проекта продолжает
  // работать, и его доступы должны оставаться привязанными.
  useEffect(() => {
    listProjects({ archived: "include" })
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const load = useCallback(() => {
    setError(null);
    listCredentials(debouncedSearch || undefined)
      .then(setItems)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setItems([]);
      });
  }, [debouncedSearch]);

  /**
   * Продление из списка. Отправляем только `renewsAt`: PATCH применяет
   * пришедшие поля и не трогает остальные, поэтому пароль и всё прочее
   * остаются как были.
   */
  async function markPaid(item: Credential) {
    const next = nextRenewalDate(toDateInputValue(item.renewsAt));
    try {
      await updateCredential(item.id, { renewsAt: fromDateInputValue(next) });
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось продлить");
    }
  }

  useEffect(load, [load]);

  // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(items, setEditing);
  useFocusFromLink(items !== null);

  // Фильтр применяется здесь, а не запросом: список доступов целиком уже в
  // памяти, и лишний поход в базу ради выборки по одному полю ничего не даст.
  const visible = items?.filter(
    (item) =>
      !projectFilter ||
      (projectFilter === NO_PROJECT ? !item.project : item.project?.id === projectFilter),
  );
  const groups = visible ? groupByProject(visible) : [];

  function toggle(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Доступы</h1>
        <div className="flex flex-wrap items-center gap-2">
          <LegacyMigration watch={items} onDone={load} />
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} strokeWidth={2.5} />
            Новая запись
          </Button>
        </div>
      </header>

      <p className="text-muted-foreground mt-1 max-w-prose text-sm">
        Что за сервис, на кого оформлен, когда продлевать и под каким паролем заходят.
        Пароли шифруются <b className="text-foreground">на сервере</b>, посмотреть их
        можно только с двухфакторным входом, и каждый просмотр остаётся в журнале.
      </p>

      <div className="mt-6 sm:mt-5">
        <div className="flex flex-wrap gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по сервису, логину или заметкам"
            className="w-full sm:w-80"
          />
          <Select
            value={projectFilter}
            onChange={setProjectFilter}
            ariaLabel="Проект"
            className="w-full sm:w-56"
            options={[
              { value: "", label: "Все проекты" },
              { value: NO_PROJECT, label: "Без проекта" },
              ...projects.map((project) => ({
                value: project.id,
                label: project.title,
              })),
            ]}
          />
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 sm:mt-5">
        {visible === undefined ? (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            title={projectFilter || debouncedSearch ? "Ничего не нашлось" : "Пока пусто"}
            note={
              debouncedSearch
                ? "Попробуйте другой запрос."
                : projectFilter
                  ? "В этом проекте доступов нет."
                  : "Заведите первую запись — хостинг, домены, почта, аналитика."
            }
          />
        ) : (
          <div className="space-y-6">
            {groups.map((group) => {
              // Единственная группа «Без проекта» заголовка не получает: там
              // нечего сворачивать и не с чем сравнивать.
              const plain = groups.length === 1 && !group.key;
              const hidden = !plain && collapsed.has(group.key);

              return (
                <div key={group.key}>
                  {!plain && (
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      aria-expanded={!hidden}
                      className="hover:text-accent-foreground mb-2 flex w-full items-center gap-1.5 text-left"
                    >
                      <ChevronRight
                        size={15}
                        strokeWidth={2.5}
                        className={cn("transition-transform", !hidden && "rotate-90")}
                      />
                      <span className="text-sm font-semibold">{group.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {group.items.length}
                      </span>
                    </button>
                  )}
                  {/* Плавность через grid-template-rows: от 0fr к 1fr. Это
                      единственный способ анимировать высоту, которая заранее
                      неизвестна, — max-height требует угадать её и на длинных
                      группах рвёт плавность. Список остаётся в разметке, но
                      обрезается обёрткой, поэтому строки не прыгают. */}
                  <div
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                      hidden ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
                    )}
                  >
                    <ul
                      className={cn(
                        "space-y-3 overflow-hidden transition-opacity duration-200 motion-reduce:transition-none sm:space-y-2",
                        hidden && "opacity-0",
                      )}
                      aria-hidden={hidden}
                    >
                      {group.items.map((item) => (
                        <Row
                          key={item.id}
                          item={item}
                          onOpen={() => setEditing(item)}
                          onPaid={() => markPaid(item)}
                          reveal={reveal}
                        />
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {creating && (
        <CredentialModal
          title="Новая запись"
          initial={empty()}
          projects={projects}
          reveal={reveal}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await createCredential(toInput(values));
            setCreating(false);
            load();
          }}
        />
      )}

      {editing && (
        <CredentialModal
          title={editing.service}
          initial={toValues(editing)}
          item={editing}
          projects={projects}
          reveal={reveal}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateCredential(editing.id, toInput(values));
            setEditing(null);
            load();
          }}
          onDelete={async () => {
            await deleteCredential(editing.id);
            setEditing(null);
            load();
          }}
        />
      )}

      {prompt}
    </section>
  );
}

/**
 * Разбивка по проектам.
 *
 * Плоский список перестаёт читаться уже на втором десятке: у одного клиента
 * набирается хостинг, домен, почта и панель, и глазами их не разделить.
 * Общие доступы — почта команды, GitHub — идут последними: к ним обращаются
 * реже, чем к проектным, и первым экраном должно быть то, что ищут чаще.
 */
function groupByProject(items: Credential[]) {
  const groups = new Map<string, { key: string; title: string; items: Credential[] }>();

  for (const item of items) {
    const key = item.project?.id ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, {
        key,
        title: item.project?.title ?? "Без проекта",
        items: [item],
      });
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.key) return 1;
    if (!b.key) return -1;
    return a.title.localeCompare(b.title, "ru");
  });
}

function Row({
  item,
  onOpen,
  onPaid,
  reveal,
}: {
  item: Credential;
  onOpen: () => void;
  onPaid: () => Promise<void>;
  reveal: RevealPassword;
}) {
  const renews = item.renewsAt ? describeDeadline(item.renewsAt) : null;
  const [saving, setSaving] = useState(false);
  const secret = useShownPassword(item.id, reveal);
  const { hide } = secret;

  // Список перечитан: запись могли поправить, а показанное значение уже устарело.
  useEffect(hide, [item, hide]);

  /*
   * Продлевать имеет смысл только то, за что платят. У записи без срока и без
   * суммы — логина от GitHub, общей почты — «Оплатил» означало бы неизвестно
   * что и просто засоряло бы список.
   */
  const payable = item.renewsAt !== null || item.amountMinor != null;
  const paidUntil = nextRenewalDate(toDateInputValue(item.renewsAt));

  return (
    <li
      data-card-id={item.id}
      className="border-border bg-background hover:border-accent-border flex flex-col gap-1.5 rounded-xl border px-3 py-3 transition hover:shadow-sm sm:py-2.5"
    >
      <div className="flex items-start gap-3">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm font-medium">{item.service}</span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {[item.login, item.owner && `на ${item.owner}`].filter(Boolean).join(" · ") ||
              "подробности не заполнены"}
          </span>
          <NoteHint text={item.notes} />
        </button>

        {item.hasPassword && (
          <button
            type="button"
            onClick={() => (secret.shown === null ? void secret.show() : secret.hide())}
            disabled={secret.loading}
            aria-label={secret.shown === null ? "Показать пароль" : "Скрыть пароль"}
            title={secret.shown === null ? "Показать пароль" : "Скрыть пароль"}
            className="text-muted-foreground hover:bg-muted hover:text-foreground mt-0.5 shrink-0 rounded-lg p-1.5 transition disabled:opacity-50"
          >
            {secret.shown === null ? (
              <Eye size={15} strokeWidth={2} />
            ) : (
              <EyeOff size={15} strokeWidth={2} />
            )}
          </button>
        )}

        {item.legacyPending && (
          <span
            title="Старый пароль ещё не перенесён: нажмите «Перенести пароли»"
            className="text-muted-foreground mt-0.5 shrink-0 p-1.5 opacity-50"
          >
            <Lock size={15} strokeWidth={2} />
          </span>
        )}

        {item.amountMinor != null && (
          <span className="mt-0.5 shrink-0 text-sm font-medium">
            {fee(item.amountMinor, item.monthlyFee, item.currency)}
          </span>
        )}

        {renews && (
          <Badge tone={renews.tone} className="mt-0.5">
            {renews.label}
          </Badge>
        )}

        {item.url && (
          <a
            href={item.url.startsWith("http") ? item.url : `https://${item.url}`}
            target="_blank"
            rel="noreferrer"
            aria-label="Открыть сервис"
            className="text-muted-foreground hover:bg-muted hover:text-foreground mt-0.5 shrink-0 rounded-lg p-1.5 transition"
          >
            <ExternalLink size={15} strokeWidth={2} />
          </a>
        )}
      </div>

      {secret.shown !== null && <ShownPassword password={secret.shown} />}
      {secret.error && <p className="text-danger text-xs">{secret.error}</p>}

      {/* Продление прямо из списка: открывать карточку ради одной даты — три
          лишних движения на записи, которых у команды десятки. Дата стоит на
          самой кнопке, поэтому нажатие не вслепую; подтверждения нет намеренно
          — промах виден сразу по сроку рядом и правится в карточке. */}
      {payable && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void onPaid().finally(() => setSaving(false));
            }}
            className="text-muted-foreground hover:bg-accent-soft hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition disabled:opacity-50"
          >
            <Check size={13} strokeWidth={2.5} />
            {saving
              ? "Продлеваем…"
              : `Оплатил до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
          </button>
        </div>
      )}
    </li>
  );
}

/** Открытый пароль сам скрывается: забытый на экране он виден всем вокруг. */
const SHOWN_MS = 30_000;

/**
 * Показ пароля в строке или карточке. Значение живёт только в этом состоянии и
 * пропадает вместе с компонентом, поэтому закрытая карточка пароль не помнит.
 */
function useShownPassword(id: string, reveal: RevealPassword) {
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setShown(null);
  }, []);

  useEffect(() => hide, [hide]);

  async function show() {
    setError(null);
    setLoading(true);
    try {
      const result = await reveal(id);
      if (!result) return;
      if (result.password === null) {
        setError("Пароль уже стёрт");
        return;
      }
      setShown(result.password);
      timer.current = setTimeout(hide, SHOWN_MS);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось открыть пароль");
    } finally {
      setLoading(false);
    }
  }

  return { shown, error, loading, show, hide };
}

/**
 * Копирование отдельной кнопкой, а не сразу после просмотра: Safari запрещает запись
 * в буфер после ожидания сети, вне жеста пользователя.
 */
function ShownPassword({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="bg-muted flex items-center gap-2 rounded-lg px-3 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap">
        {password}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Скопировать пароль"
        title={failed ? "Не получилось скопировать" : "Скопировать пароль"}
        className="text-muted-foreground hover:bg-background hover:text-foreground shrink-0 rounded-lg p-1.5 transition"
      >
        {copied ? (
          <Check size={15} strokeWidth={2.5} className="text-success" />
        ) : (
          <Copy size={15} strokeWidth={2} />
        )}
      </button>
    </div>
  );
}

/** Форма ничего не расшифровывает при открытии: пароль только по нажатию. */
function CurrentPassword({ id, reveal }: { id: string; reveal: RevealPassword }) {
  const secret = useShownPassword(id, reveal);

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium">Текущий пароль</span>
      {secret.shown !== null ? (
        <ShownPassword password={secret.shown} />
      ) : (
        <p className="text-muted-foreground text-sm">••••••••</p>
      )}
      {secret.error && <p className="text-danger mt-1 text-xs">{secret.error}</p>}
      <div className="mt-1.5">
        <Button
          type="button"
          variant="ghost"
          onClick={() => (secret.shown === null ? void secret.show() : secret.hide())}
          disabled={secret.loading}
        >
          {secret.shown === null ? (
            <Eye size={15} strokeWidth={2} />
          ) : (
            <EyeOff size={15} strokeWidth={2} />
          )}
          {secret.shown === null ? "Показать" : "Скрыть"}
        </Button>
      </div>
    </div>
  );
}

function CredentialModal({
  title,
  initial,
  item,
  projects,
  reveal,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  initial: FormValues;
  /** Сохранённая запись. Нет — создаём новую. */
  item?: Credential;
  projects: Project[];
  reveal: RevealPassword;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Сбрасывается вместе с окном: закрыли карточку — введённый пароль снова скрыт.
  const [revealed, setRevealed] = useState(false);
  const canClear = Boolean(item?.hasPassword || item?.legacyPending);

  /**
   * Куда уедет срок, если нажать «Оплатил». Считается заранее и стоит прямо на
   * кнопке: действие меняет дату, и человек должен видеть какую, а не нажимать
   * вслепую и потом искать, что изменилось.
   */
  const paidUntil = nextRenewalDate(values.renewsDate);
  /** То же условие, что в строке списка, только по значениям формы. */
  const payable = values.renewsDate !== "" || parseAmount(values.amount) !== null;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(values);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm("Удалить запись?")) return;
    setSaving(true);
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          <Field label="Сервис">
            <Input
              value={values.service}
              onChange={(event) => set("service", event.target.value)}
              required
              autoFocus
              maxLength={120}
              placeholder="reg.ru · Яндекс Метрика · Cloudflare"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Логин">
              <Input
                value={values.login}
                onChange={(event) => set("login", event.target.value)}
                maxLength={200}
              />
            </Field>

            <Field label="На кого оформлен" hint="Чья почта или карта привязана">
              <Input
                value={values.owner}
                onChange={(event) => set("owner", event.target.value)}
                maxLength={120}
                placeholder="Камиль"
              />
            </Field>
          </div>

          <Field label="Проект" hint="Пусто — общий доступ: почта, GitHub, хостинг">
            <Select
              value={values.projectId}
              onChange={(projectId) => set("projectId", projectId)}
              options={[
                { value: "", label: "Без проекта" },
                ...projects.map((project) => ({
                  value: project.id,
                  label: project.title,
                })),
              ]}
            />
          </Field>

          <Field label="Ссылка">
            <Input
              value={values.url}
              onChange={(event) => set("url", event.target.value)}
              maxLength={300}
              placeholder="https://reg.ru"
            />
          </Field>

          {item?.hasPassword && <CurrentPassword id={item.id} reveal={reveal} />}

          <Field
            label={item?.hasPassword ? "Новый пароль" : "Пароль"}
            hint={
              item?.legacyPending
                ? "Старый пароль ещё не перенесён. Новый заменит его"
                : item?.hasPassword
                  ? "Пусто — не менять"
                  : "Шифруется на сервере. Пусто — пароль не хранится"
            }
          >
            {/*
             * autoComplete обязателен: иначе браузер подставит пароль от CRM, и
             * «Сохранить» молча заменит им пароль сервиса.
             */}
            <div className="relative">
              <Input
                type={revealed ? "text" : "password"}
                value={values.password}
                onChange={(event) => set("password", event.target.value)}
                disabled={values.clearPassword}
                autoComplete="new-password"
                maxLength={500}
                className={cn(values.password && "pr-10", revealed && "font-mono")}
              />
              {values.password !== "" && (
                <button
                  type="button"
                  onClick={() => setRevealed((shown) => !shown)}
                  aria-label={revealed ? "Скрыть пароль" : "Показать пароль"}
                  title={revealed ? "Скрыть" : "Показать"}
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 transition"
                >
                  {revealed ? (
                    <EyeOff size={15} strokeWidth={2} />
                  ) : (
                    <Eye size={15} strokeWidth={2} />
                  )}
                </button>
              )}
            </div>
          </Field>

          {canClear &&
            (values.clearPassword ? (
              <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
                Пароль будет стёрт при сохранении.
                <button
                  type="button"
                  onClick={() => set("clearPassword", false)}
                  className="text-foreground underline underline-offset-2"
                >
                  Отменить
                </button>
              </p>
            ) : (
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  set("password", "");
                  set("clearPassword", true);
                }}
              >
                Стереть пароль
              </Button>
            ))}

          <Field label="Продлить до" hint="Попадёт наверх списка, когда срок подойдёт">
            <Input
              type="date"
              value={values.renewsDate}
              onChange={(event) => set("renewsDate", event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Сумма"
              hint="Можно с копейками: 1200 или 5,19. Пустое — не задано"
            >
              <div className="flex gap-2">
                <Input
                  value={values.amount}
                  onChange={(event) => set("amount", sanitizeAmount(event.target.value))}
                  inputMode="numeric"
                  placeholder="1200"
                />
                <CurrencySelect
                  value={values.currency}
                  onChange={(currency) => set("currency", currency)}
                />
              </div>
            </Field>

            <label className="flex cursor-pointer items-start gap-2.5 sm:mt-7">
              <input
                type="checkbox"
                checked={values.monthlyFee}
                onChange={(event) => set("monthlyFee", event.target.checked)}
                className="accent-accent mt-0.5 size-4 shrink-0"
              />
              <span className="text-sm">
                Списывается каждый месяц
                <span className="text-muted-foreground mt-0.5 block text-sm">
                  Иначе сумма считается платой за период продления
                </span>
              </span>
            </label>
          </div>

          <Field label="Заметки">
            <Textarea
              value={values.notes}
              onChange={(event) => set("notes", event.target.value)}
              rows={3}
              placeholder="Тариф, что именно там лежит, к кому идти за доступом"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="danger"
              className="ml-auto"
              onClick={() => void handleDelete()}
              disabled={saving}
            >
              Удалить
            </Button>
          )}
        </div>

        {/* Продление стоит отдельной строкой под всеми кнопками: это не способ
            закрыть форму, а действие над одним полем, и в ряду с «Сохранить» и
            «Удалить» оно читалось бы как третий способ выйти из окна.

            Отдельной отметки «оплачено» у записи нет намеренно: оплата домена
            или подписки означает ровно одно — срок сдвинулся вперёд. Кнопка
            только подставляет дату в форму; записывается она обычным
            «Сохранить», поэтому промах отменяется закрытием окна. */}
        {payable && (
          <div className="mt-3 flex justify-center">
            <Button
              type="button"
              variant="ghost"
              onClick={() => set("renewsDate", paidUntil)}
              disabled={saving || values.renewsDate === paidUntil}
              title={`Продлить срок до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
            >
              <Check size={15} strokeWidth={2.5} />
              Оплатил до {formatDate(fromDateInputValue(paidUntil) ?? "")}
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

export { KeyRound as CredentialsIcon };
