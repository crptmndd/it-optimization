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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
  List,
  LoadingRows,
  Modal,
  PageHeader,
  SearchField,
  SectionTitle,
  Select,
  Switch,
  Textarea,
} from "@/components/ui";
import { DateField } from "@/components/date-field";
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
      <PageHeader
        title="Доступы"
        subtitle="Пароли открываются кодом 2FA, каждый просмотр в журнале"
      >
        <div className="flex flex-wrap items-center gap-2">
          <LegacyMigration watch={items} onDone={load} />
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} strokeWidth={2.5} />
            Новая запись
          </Button>
        </div>
      </PageHeader>

      {/* flex-1 вместо w-full: на телефоне поиск свёрнут в значок, и список занимает
          остаток ряда. Развёрнутый поиск забирает ширину целиком, список уходит ниже.
          С боковой колонкой на 768px обе ширины целиком не помещаются, поэтому поиск
          сжимается, иначе ряд распался бы надвое. */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Поиск по сервису, логину или заметкам"
          className="sm:max-w-80 sm:flex-1"
        />
        <Select
          value={projectFilter}
          onChange={setProjectFilter}
          ariaLabel="Проект"
          className="bg-background shadow-card min-w-0 flex-1 rounded-xl sm:w-56 sm:flex-none"
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

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {visible === undefined ? (
          <LoadingRows />
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
                    // Кнопка растянута на весь ряд через after, а не обёрнута вокруг
                    // заголовка: h2 внутри <button> недопустим по разметке, а
                    // сворачивать должно нажатие в любом месте ряда.
                    <div className="group relative">
                      <SectionTitle title={group.title} count={group.items.length}>
                        <button
                          type="button"
                          onClick={() => toggle(group.key)}
                          aria-expanded={!hidden}
                          aria-label={group.title}
                          className="text-muted-foreground group-hover:text-foreground flex size-6 shrink-0 items-center justify-center transition-colors after:absolute after:inset-0"
                        >
                          <ChevronRight
                            size={17}
                            strokeWidth={2.25}
                            className={cn("transition-transform", !hidden && "rotate-90")}
                          />
                        </button>
                      </SectionTitle>
                    </div>
                  )}
                  {/* Плавность через grid-template-rows: от 0fr к 1fr. Это
                      единственный способ анимировать высоту, которая заранее
                      неизвестна, — max-height требует угадать её и на длинных
                      группах рвёт плавность. Список остаётся в разметке, но
                      обрезается своим overflow-hidden, поэтому строки не прыгают.
                      opacity гасит и тень карточки: у сжатого в ноль списка от неё
                      осталась бы линия. */}
                  <div
                    aria-hidden={hidden}
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
                      hidden ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
                    )}
                  >
                    <List
                      className={cn(
                        "transition-opacity duration-200 motion-reduce:transition-none",
                        hidden && "opacity-0",
                      )}
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
                    </List>
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

/** Значок-действие в строке: показать пароль, открыть сайт. */
const iconActionClass =
  "text-muted-foreground hover:bg-disabled hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-50";

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
  const actions = item.hasPassword || item.legacyPending || item.url || payable;

  return (
    <li data-card-id={item.id} className="hover:bg-muted/60 transition-colors">
      {/* В одну линию только с xl: на всё нужно около 800px, а боковая колонка
          оставляет столько лишь с этой ширины. Ниже действия идут второй строкой,
          иначе название сжимается до пары букв. Карточку открывает нажатие в любом
          месте ряда: кнопка растянута через after, действия лежат поверх неё. */}
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 xl:flex-nowrap">
        <button
          type="button"
          onClick={onOpen}
          className="grid min-h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-left after:absolute after:inset-0 xl:w-auto xl:flex-1 xl:grid-cols-[minmax(0,1fr)_7rem_9.75rem]"
        >
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold">
              {item.service}
            </span>
            <span className="text-muted-foreground mt-0.5 flex gap-2 text-[13px] font-medium">
              {item.login && <span className="min-w-0 truncate">{item.login}</span>}
              {item.owner && (
                <span className="max-w-[50%] shrink-0 truncate">на {item.owner}</span>
              )}
              {!item.login && !item.owner && "подробности не заполнены"}
            </span>
            <NoteHint text={item.notes} />
          </span>

          {/* Узкий экран: сумма над сроком справа от названия. На xl обёртка
              растворяется, и оба становятся колонками: пустая ячейка держит
              столбец, чтобы суммы и сроки стояли друг под другом. */}
          <span className="flex flex-col items-end gap-0.5 xl:contents">
            <span className="text-right text-sm font-semibold whitespace-nowrap tabular-nums max-xl:empty:hidden">
              {item.amountMinor != null &&
                fee(item.amountMinor, item.monthlyFee, item.currency)}
            </span>
            <span className="flex justify-end max-xl:empty:hidden">
              {renews && <Badge tone={renews.tone}>{renews.label}</Badge>}
            </span>
          </span>
        </button>

        <div
          className={cn(
            "relative flex w-full items-center gap-0.5 xl:w-auto",
            !actions && "hidden xl:flex",
          )}
        >
          {item.hasPassword && (
            <button
              type="button"
              onClick={() => (secret.shown === null ? void secret.show() : secret.hide())}
              disabled={secret.loading}
              aria-label={secret.shown === null ? "Показать пароль" : "Скрыть пароль"}
              title={secret.shown === null ? "Показать пароль" : "Скрыть пароль"}
              className={iconActionClass}
            >
              {secret.shown === null ? (
                <Eye size={17} strokeWidth={2.25} />
              ) : (
                <EyeOff size={17} strokeWidth={2.25} />
              )}
            </button>
          )}

          {item.legacyPending && (
            <span
              title="Старый пароль ещё не перенесён: нажмите «Перенести пароли»"
              className="text-muted-foreground flex size-8 shrink-0 items-center justify-center opacity-50"
            >
              <Lock size={17} strokeWidth={2.25} />
            </span>
          )}

          {/* Без пароля значка нет, но на xl место за ним держится: иначе значки
              соседних строк стояли бы вразнобой. */}
          {!item.hasPassword && !item.legacyPending && (
            <span className="hidden size-8 shrink-0 xl:block" />
          )}

          {item.url ? (
            <a
              href={item.url.startsWith("http") ? item.url : `https://${item.url}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Открыть сервис"
              className={iconActionClass}
            >
              <ExternalLink size={17} strokeWidth={2.25} />
            </a>
          ) : (
            <span className="hidden size-8 shrink-0 xl:block" />
          )}

          {/* Продление прямо из списка: открывать карточку ради одной даты — три
              лишних движения на записи, которых у команды десятки. Дата стоит на
              самой кнопке, поэтому нажатие не вслепую; подтверждения нет намеренно
              — промах виден сразу по сроку рядом и правится в карточке. */}
          <div className="ml-auto flex justify-end pl-2 xl:ml-0 xl:w-[14.5rem]">
            {payable && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setSaving(true);
                  void onPaid().finally(() => setSaving(false));
                }}
              >
                <Check size={15} strokeWidth={2.5} />
                {saving
                  ? "Продлеваем…"
                  : `Оплатил до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
              </Button>
            )}
          </div>
        </div>
      </div>

      {(secret.shown !== null || secret.error) && (
        <div className="space-y-1.5 px-4 pb-2.5">
          {secret.shown !== null && <ShownPassword password={secret.shown} />}
          {secret.error && <p className="text-danger text-xs">{secret.error}</p>}
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
          <Copy size={15} strokeWidth={2.25} />
        )}
      </button>
    </div>
  );
}

/** Форма ничего не расшифровывает при открытии: пароль только по нажатию. */
function CurrentPassword({ id, reveal }: { id: string; reveal: RevealPassword }) {
  const secret = useShownPassword(id, reveal);

  return (
    <div className="min-w-0">
      <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
        Текущий пароль
      </span>
      {secret.shown !== null ? (
        <ShownPassword password={secret.shown} />
      ) : (
        <p className="bg-field text-muted-foreground flex h-10 items-center rounded-lg px-3 text-sm">
          ••••••••
        </p>
      )}
      {secret.error && <p className="text-danger mt-1 text-xs">{secret.error}</p>}
      <div className="mt-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => (secret.shown === null ? void secret.show() : secret.hide())}
          disabled={secret.loading}
        >
          {secret.shown === null ? (
            <Eye size={15} strokeWidth={2.25} />
          ) : (
            <EyeOff size={15} strokeWidth={2.25} />
          )}
          {secret.shown === null ? "Показать" : "Скрыть"}
        </Button>
      </div>
    </div>
  );
}

/** Блок формы: мелкий заголовок вместо рамки, справа действие над его полями. */
function FormBlock({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      {/* min-h под кнопку: она появляется, пока вводят сумму, и поля не должны прыгать. */}
      <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>
        {action}
      </div>
      {children}
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
  // Заметки нужны не каждой записи: пустое поле только удлиняло окно.
  const [notesOpen, setNotesOpen] = useState(initial.notes !== "");
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
        <div className="space-y-5">
          <div className="space-y-4">
            <Field label="Сервис">
              <Input
                value={values.service}
                onChange={(event) => set("service", event.target.value)}
                required
                autoFocus
                maxLength={120}
                placeholder="reg.ru · Яндекс Метрика · Cloudflare"
                className="h-12 text-base font-semibold"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Проект">
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

              <Field label="На кого оформлен">
                <Input
                  value={values.owner}
                  onChange={(event) => set("owner", event.target.value)}
                  maxLength={120}
                  placeholder="Камиль"
                />
              </Field>
            </div>
          </div>

          <FormBlock title="Вход">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ссылка">
                <Input
                  value={values.url}
                  onChange={(event) => set("url", event.target.value)}
                  maxLength={300}
                  placeholder="https://reg.ru"
                />
              </Field>

              <Field label="Логин">
                <Input
                  value={values.login}
                  onChange={(event) => set("login", event.target.value)}
                  maxLength={200}
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
                className={cn(!item?.hasPassword && "sm:col-span-2")}
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
                        <EyeOff size={15} strokeWidth={2.25} />
                      ) : (
                        <Eye size={15} strokeWidth={2.25} />
                      )}
                    </button>
                  )}
                </div>
              </Field>
            </div>

            {canClear && (
              <div className="mt-2">
                {values.clearPassword ? (
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
                    size="sm"
                    className="-ml-3"
                    onClick={() => {
                      set("password", "");
                      set("clearPassword", true);
                    }}
                  >
                    Стереть пароль
                  </Button>
                )}
              </div>
            )}
          </FormBlock>

          {/* «Оплатил» стоит в заголовке блока, рядом с полем, которое меняет: это не
              способ закрыть форму, и в ряду с «Сохранить» и «Удалить» оно читалось бы
              как третий способ выйти из окна.

              Отдельной отметки «оплачено» у записи нет намеренно: оплата домена
              или подписки означает ровно одно — срок сдвинулся вперёд. Кнопка
              только подставляет дату в форму; записывается она обычным
              «Сохранить», поэтому промах отменяется закрытием окна. */}
          <FormBlock
            title="Оплата"
            action={
              payable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => set("renewsDate", paidUntil)}
                  disabled={saving || values.renewsDate === paidUntil}
                  title={`Продлить срок до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
                >
                  <Check size={15} strokeWidth={2.5} />
                  Оплатил до {formatDate(fromDateInputValue(paidUntil) ?? "")}
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Продлить до">
                  <DateField
                    value={values.renewsDate}
                    onChange={(next) => set("renewsDate", next)}
                    placeholder="Без срока"
                    clearLabel="Убрать срок"
                    ariaLabel="Продлить до"
                  />
                </Field>

                <Field label="Сумма">
                  <div className="flex gap-2">
                    <Input
                      value={values.amount}
                      onChange={(event) =>
                        set("amount", sanitizeAmount(event.target.value))
                      }
                      inputMode="numeric"
                      placeholder="1200"
                    />
                    <CurrencySelect
                      value={values.currency}
                      onChange={(currency) => set("currency", currency)}
                    />
                  </div>
                </Field>
              </div>

              <Switch
                checked={values.monthlyFee}
                onChange={(monthlyFee) => set("monthlyFee", monthlyFee)}
                label="Списывается каждый месяц"
                hint="Иначе сумма считается платой за период продления"
              />
            </div>
          </FormBlock>

          {notesOpen ? (
            <Field label="Заметки">
              {/* Пустое поле открыли нажатием, и печатать будут сразу. У записи с
                  заметками оно открыто с начала, и фокус остаётся на «Сервисе». */}
              <Textarea
                value={values.notes}
                onChange={(event) => set("notes", event.target.value)}
                rows={3}
                autoFocus={values.notes === ""}
                placeholder="Тариф, что именно там лежит, к кому идти за доступом"
              />
            </Field>
          ) : (
            <button
              type="button"
              onClick={() => setNotesOpen(true)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px] font-semibold transition"
            >
              <Plus size={15} strokeWidth={2.5} />
              Добавить заметку
            </button>
          )}
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="danger"
              className="h-11"
              onClick={() => void handleDelete()}
              disabled={saving}
            >
              Удалить
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export { KeyRound as CredentialsIcon };
