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
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
import { useVault } from "@/vault/vault-context";
import { VaultControl } from "./vault-panel";

/**
 * Справочник учёток сервисов, включая пароли.
 *
 * Пароли шифруются здесь же, в браузере: на сервер уходит шифротекст, ключ
 * выводится из мастер-фразы и наружу не попадает. База по-прежнему уезжает в
 * ночные дампы, но теперь их утечка отдаёт нечитаемый текст, а не все сервисы
 * разом — раньше именно из-за этого паролей здесь не было вовсе.
 *
 * Отсюда правило, которое легко нарушить: открытый пароль существует только в
 * состоянии формы и в буфере обмена. Его нельзя ни отправить на сервер, ни
 * положить в localStorage, ни записать в журнал.
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
  /** Открытый пароль. Живёт только в состоянии формы — наружу уходит шифротекст. */
  secret: string;
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
    secret: "",
    notes: "",
  };
}

function toValues(item: Credential, secret: string): FormValues {
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
    secret,
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
  };
}

/**
 * Что можно делать с паролем открытой карточки.
 *
 * `unreadable` — отдельное состояние, а не разновидность запертого: шифротекст
 * есть, но текущий ключ его не берёт (например, фразу сбросили в другой
 * вкладке). Раньше такая запись запиралась намертво — прочитать нельзя и
 * заменить нельзя. Теперь заменить можно: пустое поле оставляет старое,
 * заполненное перезаписывает.
 *
 * `uninitialized` отделено от `locked` по той же причине: «разблокируйте
 * хранилище» там, где хранилища ещё нет, отправляет искать несуществующую
 * кнопку.
 */
type SecretState = "editable" | "unreadable" | "locked" | "uninitialized";

interface EditTarget {
  item: Credential;
  secret: string;
  secretState: SecretState;
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
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const { unlocked, configured, revision, encryptSecret, decryptSecret } = useVault();

  /** Состояние поля пароля, когда ключа нет: фразы вовсе нет или просто заперто. */
  const closedState: SecretState = configured === false ? "uninitialized" : "locked";

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
   * пришедшие поля и не трогает остальные, поэтому шифротекст пароля и всё
   * прочее остаются как были.
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

  useEffect(() => {
    // `revision` здесь не украшение: после сброса сервер обнулил все
    // шифротексты, а список в памяти остался со старыми. Без перезагрузки
    // записи выглядят как «пароль сохранён», хотя его больше нет, и карточка
    // запирается — новый ключ старый шифротекст не читает.
    void revision;
    load();
  }, [load, revision]);

  /**
   * Расшифровка при открытии карточки, а не при сохранении: тогда поле пароля
   * ведёт себя как все остальные — что видно, то и сохранится. Иначе пустое
   * поле означало бы то «не менять», то «стереть», и однажды стёрло бы.
   */
  async function openEdit(item: Credential) {
    if (!unlocked) {
      setEditing({ item, secret: "", secretState: closedState });
      return;
    }
    if (!item.secret) {
      setEditing({ item, secret: "", secretState: "editable" });
      return;
    }
    try {
      setEditing({
        item,
        secret: await decryptSecret(item.secret),
        secretState: "editable",
      });
    } catch {
      setEditing({ item, secret: "", secretState: "unreadable" });
    }
  }

  /**
   * Поле пароля опускается, когда стирать его было бы не решением человека, а
   * побочным эффектом: при запертом хранилище — всегда, при нечитаемом
   * шифротексте — если поле оставили пустым.
   */
  async function buildInput(values: FormValues, state: SecretState) {
    const input = toInput(values);
    if (state === "locked" || state === "uninitialized") return input;
    if (state === "unreadable" && !values.secret) return input;
    return {
      ...input,
      secret: values.secret ? await encryptSecret(values.secret) : null,
    };
  }

  // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(items, (item) => void openEdit(item));
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
        <div className="flex items-center gap-2">
          <VaultControl />
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} strokeWidth={2.5} />
            Новая запись
          </Button>
        </div>
      </header>

      <p className="text-muted-foreground mt-1 max-w-prose text-sm">
        Что за сервис, на кого оформлен, когда продлевать и под каким паролем заходят.
        Пароли шифруются <b className="text-foreground">в браузере</b>: на сервер уходит
        только шифротекст, и прочитать его без мастер-фразы нельзя никому — включая тех, у
        кого есть доступ к серверу.
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
            title={projectFilter ? "Ничего не нашлось" : "Пока пусто"}
            note={
              projectFilter
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
                          onOpen={() => void openEdit(item)}
                          onPaid={() => markPaid(item)}
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
          secretState={unlocked ? "editable" : closedState}
          hasSecret={false}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await createCredential(
              await buildInput(values, unlocked ? "editable" : closedState),
            );
            setCreating(false);
            load();
          }}
        />
      )}

      {editing && (
        <CredentialModal
          title={editing.item.service}
          initial={toValues(editing.item, editing.secret)}
          projects={projects}
          secretState={editing.secretState}
          hasSecret={Boolean(editing.item.secret)}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateCredential(
              editing.item.id,
              await buildInput(values, editing.secretState),
            );
            setEditing(null);
            load();
          }}
          onDelete={async () => {
            await deleteCredential(editing.item.id);
            setEditing(null);
            load();
          }}
        />
      )}
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
}: {
  item: Credential;
  onOpen: () => void;
  onPaid: () => Promise<void>;
}) {
  const renews = item.renewsAt ? describeDeadline(item.renewsAt) : null;
  const [saving, setSaving] = useState(false);

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

        <SecretButton item={item} />

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

/**
 * Пароль отдаётся в буфер обмена, а не на экран: он нужен, чтобы его вставить,
 * а показанный текст видят все, кто смотрит в монитор.
 */
function SecretButton({ item }: { item: Credential }) {
  const { unlocked, decryptSecret } = useVault();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  if (!item.secret) return null;

  if (!unlocked) {
    return (
      <span
        title="Пароль сохранён — разблокируйте хранилище"
        className="text-muted-foreground mt-0.5 shrink-0 p-1.5 opacity-50"
      >
        <Lock size={15} strokeWidth={2} />
      </span>
    );
  }

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(await decryptSecret(item.secret!));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Скопировать пароль"
      title={failed ? "Не получилось скопировать" : "Скопировать пароль"}
      className="text-muted-foreground hover:bg-muted hover:text-foreground mt-0.5 shrink-0 rounded-lg p-1.5 transition"
    >
      {copied ? (
        <Check size={15} strokeWidth={2.5} className="text-success" />
      ) : (
        <Copy size={15} strokeWidth={2} />
      )}
    </button>
  );
}

/**
 * Подсказка под полем пароля.
 *
 * Каждое состояние называет следующий шаг человека, а не своё внутреннее имя:
 * «разблокируйте хранилище» там, где хранилища ещё нет, отправляло бы искать
 * кнопку, которой в интерфейсе не существует.
 */
function secretHint(state: SecretState, hasSecret: boolean): string {
  switch (state) {
    case "editable":
      return "Шифруется в браузере. Пустое поле — пароль не хранится";
    case "unreadable":
      return "Зашифрован другой фразой и не читается. Введите новый, чтобы заменить — пустое поле оставит старый";
    case "uninitialized":
      return "Сначала задайте мастер-фразу — ею шифруются пароли";
    case "locked":
      return hasSecret
        ? "Сохранён. Разблокируйте хранилище, чтобы увидеть или заменить"
        : "Разблокируйте хранилище, чтобы сохранить пароль";
  }
}

function CredentialModal({
  title,
  initial,
  projects,
  secretState,
  hasSecret,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  initial: FormValues;
  projects: Project[];
  secretState: SecretState;
  hasSecret: boolean;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Сбрасывается вместе с окном: закрыли карточку — пароль снова скрыт.
  const [revealed, setRevealed] = useState(false);

  /**
   * Куда уедет срок, если нажать «Оплатил». Считается заранее и стоит прямо на
   * кнопке: действие меняет дату, и человек должен видеть какую, а не нажимать
   * вслепую и потом искать, что изменилось.
   */
  const paidUntil = nextRenewalDate(values.renewsDate);

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

          <Field label="Пароль" hint={secretHint(secretState, hasSecret)}>
            {/*
             * Показать пароль можно, но по умолчанию он скрыт: чаще его
             * копируют, а открытый текст видит любой, кто смотрит в монитор.
             * Глазок нужен там, где буфер обмена не помогает, — ввести на
             * телефоне, на роутере, продиктовать.
             */}
            <div className="relative">
              <Input
                type={revealed ? "text" : "password"}
                value={values.secret}
                onChange={(event) => set("secret", event.target.value)}
                disabled={secretState === "locked" || secretState === "uninitialized"}
                autoComplete="new-password"
                placeholder={
                  secretState === "unreadable"
                    ? "новый пароль"
                    : // Точки обещают сохранённый пароль, поэтому рисуются
                      // только когда он и правда есть.
                      hasSecret && secretState === "locked"
                      ? "••••••••"
                      : ""
                }
                maxLength={500}
                className={cn(values.secret && "pr-10", revealed && "font-mono")}
              />
              {values.secret !== "" && (
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
      </form>
    </Modal>
  );
}

export { KeyRound as CredentialsIcon };
