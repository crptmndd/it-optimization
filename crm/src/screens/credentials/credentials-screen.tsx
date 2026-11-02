import { KeyRound, Plus } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import { ApiError } from "@/api/client";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  updateCredential,
  type Credential,
} from "@/api/credentials";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  Modal,
  PageHeader,
  SearchField,
  SectionTitle,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  describeDeadline,
  fromDateInputValue,
  nextRenewalDate,
  toDateInputValue,
} from "@/lib/dates";
import { listProjects, type Project } from "@/api/projects";
import { fee } from "@/lib/money";
import { useRevealPassword } from "@/components/two-factor-prompt";
import { CredentialCard, PaidButton, renewsSoon } from "./credential-card";
import { CredentialModal, empty, toInput, toValues } from "./credential-form";
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

/** Значение фильтра для записей без проекта: пустая строка уже занята под «все». */
const NO_PROJECT = "none";

function inProject(item: Credential, filter: string): boolean {
  if (!filter) return true;
  return filter === NO_PROJECT ? !item.project : item.project?.id === filter;
}

/** С этой ширины, она же `lg`, карточка стоит рядом со списком, а не в окне. */
const WIDE = "(min-width: 1024px)";

function subscribeWide(notify: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);
}

/** Запись, к которой надо подвести, даже если её сейчас прячет поиск или фильтр. */
interface Target {
  id: string;
  /** На узком экране карточка живёт в окне: открыть его, когда запись найдётся. */
  open: boolean;
}

export function CredentialsScreen() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  /** Ответ на текущий поиск: из него строится список. */
  const [items, setItems] = useState<Credential[] | null>(null);
  /**
   * Все записи. Поиск идёт на сервере, а блоку продлений и переходам к записи он не
   * указ: иначе блок прыгал бы над полем прямо во время ввода.
   */
  const [all, setAll] = useState<Credential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  /** Пусто — все проекты, NO_PROJECT — записи без привязки, иначе id проекта. */
  const [projectFilter, setProjectFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  /** Окно карточки на узком экране. */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Credential | null>(null);
  // Одно окно кода на экран: и карточка, и форма просят его одинаково.
  const { reveal, prompt } = useRevealPassword();
  const wide = useWide();
  const [params] = useSearchParams();
  const focusId = params.get("focus");

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

  const load = useCallback(async () => {
    setError(null);
    try {
      const [found, whole] = await Promise.all([
        listCredentials(debouncedSearch || undefined),
        debouncedSearch ? listCredentials() : null,
      ]);
      setItems(found);
      setAll(whole ?? found);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      setItems([]);
      setAll((current) => current ?? []);
    }
  }, [debouncedSearch]);

  /**
   * Продление из карточки или блока. Отправляем только `renewsAt`: PATCH применяет
   * пришедшие поля и не трогает остальные, поэтому пароль и всё прочее
   * остаются как были.
   */
  async function markPaid(item: Credential) {
    const next = nextRenewalDate(toDateInputValue(item.renewsAt));
    try {
      await updateCredential(item.id, { renewsAt: fromDateInputValue(next) });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось продлить");
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  // Глобальный поиск (?open=<id>) и «Сегодня» (?focus=<id>) ведут к записи одинаково:
  // ставят цель, а дальше её ведёт эффект ниже. Хуки только убирают параметр из адреса
  // и подсвечивают строку.
  const goToLinked = useCallback(
    (item: Credential) => setTarget({ id: item.id, open: true }),
    [],
  );
  useOpenFromSearch(all, goToLinked);
  useEffect(() => {
    if (focusId) setTarget({ id: focusId, open: true });
  }, [focusId]);

  /*
   * Запись могут прятать поиск и фильтр проекта, и снимать их надо по очереди: строка
   * появится только после нового ответа сервера. Поэтому цель лежит в состоянии и
   * ждёт, пока список догонит, а не выбирается в момент нажатия.
   */
  useEffect(() => {
    if (!target || !items || !all) return;

    const item = all.find((entry) => entry.id === target.id);
    if (!item) {
      // Запись удалили в другой вкладке: вести больше некуда.
      setTarget(null);
      return;
    }
    if (!items.some((entry) => entry.id === item.id)) {
      if (debouncedSearch) {
        setSearch("");
        setDebouncedSearch("");
      }
      return;
    }
    if (!inProject(item, projectFilter)) {
      setProjectFilter("");
      return;
    }

    setTarget(null);
    setSelectedId(item.id);
    if (target.open && !wide) setSheetOpen(true);
    document
      .querySelector(`[data-card-id="${CSS.escape(item.id)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [target, items, all, debouncedSearch, projectFilter, wide]);

  // Окно не должно пережить поворот планшета: на широком экране карточка уже рядом.
  useEffect(() => {
    if (wide) setSheetOpen(false);
  }, [wide]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  // Фильтр применяется здесь, а не запросом: список доступов целиком уже в
  // памяти, и лишний поход в базу ради выборки по одному полю ничего не даст.
  const visible = items?.filter((item) => inProject(item, projectFilter));
  const groups = visible ? groupByProject(visible) : [];
  /** В порядке показа: сосед при удалении и первая запись считаются по нему. */
  const rows = groups.flatMap((group) => group.items);

  // На широком экране панель не пустует: скрытую фильтром запись заменяет первая
  // видимая, а прежний выбор вернётся, когда фильтр снимут.
  const selected =
    rows.find((item) => item.id === selectedId) ?? (wide ? rows[0] : undefined);
  // Поверх формы окно не держим: Escape закрыл бы оба разом.
  const sheetItem = !wide && sheetOpen && !editing ? selected : undefined;

  // Подсветка ждёт выбора. Хук вешает класс прямо на строку, и смена её className
  // следующим рендером стёрла бы его, а раньше строки и вовсе может не быть в разметке.
  useFocusFromLink(Boolean(focusId) && selected?.id === focusId);

  // Срок считается по всем записям: горящее продление не должно пропадать из-за поиска.
  const renewals = (all ?? [])
    .filter(renewsSoon)
    .sort((a, b) => a.renewsAt!.localeCompare(b.renewsAt!));

  function choose(item: Credential) {
    setSelectedId(item.id);
    if (!wide) setSheetOpen(true);
  }

  const emptyState = (
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
  );

  /* flex-1 вместо w-full: на телефоне поиск свёрнут в значок, и список занимает
     остаток ряда. Развёрнутый поиск забирает ширину целиком, список уходит ниже.
     С боковой колонкой на 768px обе ширины целиком не помещаются, поэтому поиск
     сжимается, иначе ряд распался бы надвое. В колонке списка они стоят друг под
     другом: подсказка поиска длиннее половины колонки. */
  const filters = (
    <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
      <SearchField
        value={search}
        onChange={setSearch}
        placeholder="Поиск по сервису, логину или заметкам"
        className="sm:max-w-80 sm:flex-1 lg:w-full lg:max-w-none lg:flex-none"
      />
      <Select
        value={projectFilter}
        onChange={setProjectFilter}
        ariaLabel="Проект"
        className="bg-background shadow-card min-w-0 flex-1 rounded-xl sm:w-56 sm:flex-none lg:w-full"
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
  );

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

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {/* На узком экране ищут первым делом, и длинный блок продлений не должен уводить
          поле вниз. На широком блок идёт во всю ширину, а поле стоит над списком. */}
      {!wide && <div className="mt-5">{filters}</div>}

      {renewals.length > 0 && (
        <div className="mt-6">
          <SectionTitle title="Скоро продлить" count={renewals.length} />
          <List>
            {renewals.map((item) => (
              <RenewalRow
                key={item.id}
                item={item}
                onSelect={() => setTarget({ id: item.id, open: true })}
                onPaid={() => markPaid(item)}
              />
            ))}
          </List>
        </div>
      )}

      <div className="mt-6 lg:grid lg:grid-cols-[22rem_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className="min-w-0">
          {wide && <div className="mb-5">{filters}</div>}

          {visible === undefined ? (
            <LoadingRows />
          ) : visible.length === 0 ? (
            !wide && emptyState
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <div key={group.key}>
                  {/* Единственной группе «Без проекта» заголовок ничего не добавит. */}
                  {!(groups.length === 1 && !group.key) && (
                    <SectionTitle title={group.title} count={group.items.length} />
                  )}
                  <List>
                    {group.items.map((item) => (
                      <Row
                        key={item.id}
                        item={item}
                        selected={item.id === selected?.id}
                        onSelect={() => choose(item)}
                      />
                    ))}
                  </List>
                </div>
              ))}
            </div>
          )}
        </div>

        {wide &&
          (selected ? (
            <CredentialCard
              key={selected.id}
              item={selected}
              reveal={reveal}
              onEdit={() => setEditing(selected)}
              onPaid={() => markPaid(selected)}
              className="sticky top-0 max-h-[calc(100dvh-3.5rem)] overflow-y-auto"
            />
          ) : visible === undefined ? (
            <LoadingRows />
          ) : (
            emptyState
          ))}
      </div>

      {sheetItem && (
        <Modal key={sheetItem.id} title={sheetItem.service} onClose={closeSheet}>
          {/* Общая ошибка лежит под окном, а продлить можно и отсюда. */}
          {error && (
            <div className="mb-4">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}
          <CredentialCard
            item={sheetItem}
            reveal={reveal}
            onEdit={() => setEditing(sheetItem)}
            onPaid={() => markPaid(sheetItem)}
            inModal
          />
        </Modal>
      )}

      {creating && (
        <CredentialModal
          title="Новая запись"
          initial={empty()}
          projects={projects}
          reveal={reveal}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const created = await createCredential(toInput(values));
            await load();
            setCreating(false);
            setTarget({ id: created.id, open: false });
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
            await load();
            setEditing(null);
            // Правка могла увести запись из-под фильтра, а выбранной она должна остаться.
            setTarget({ id: editing.id, open: false });
          }}
          onDelete={async () => {
            const index = rows.findIndex((item) => item.id === editing.id);
            const neighbour = rows[index + 1] ?? rows[index - 1];
            await deleteCredential(editing.id);
            await load();
            setEditing(null);
            setSheetOpen(false);
            setSelectedId(neighbour?.id ?? null);
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
  selected,
  onSelect,
}: {
  item: Credential;
  selected: boolean;
  onSelect: () => void;
}) {
  const soon = renewsSoon(item) ? describeDeadline(item.renewsAt!) : null;

  return (
    <li
      data-card-id={item.id}
      className={cn(
        // На телефоне низ экрана закрыт панелью разделов: строка не должна встать под неё.
        "scroll-my-4 transition-colors max-md:scroll-mb-24",
        selected ? "bg-accent-soft" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{item.service}</span>
          {item.login && (
            <span className="text-muted-foreground mt-0.5 block truncate text-[13px] font-medium">
              {item.login}
            </span>
          )}
        </span>
        {soon && <Badge tone={soon.tone}>{soon.label}</Badge>}
      </button>
    </li>
  );
}

function RenewalRow({
  item,
  onSelect,
  onPaid,
}: {
  item: Credential;
  onSelect: () => void;
  onPaid: () => Promise<void>;
}) {
  const deadline = describeDeadline(item.renewsAt!);

  return (
    <li className="hover:bg-muted/60 relative grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 transition-colors lg:grid-cols-[minmax(0,1fr)_auto_auto] xl:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_6.5rem_9.75rem_minmax(11rem,auto)]">
      {/* Строку выбирает нажатие в любом месте: кнопка растянута, «Оплатил» лежит поверх. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={item.service}
        className="absolute inset-0 focus-visible:-outline-offset-2"
      />

      <span className="block min-w-0 truncate text-[15px] font-semibold">
        {item.service}
      </span>

      <span className="text-muted-foreground block min-w-0 truncate text-[13px] font-medium max-xl:col-start-1 max-xl:row-start-2 max-xl:empty:hidden">
        {item.project?.title}
      </span>

      <span className="text-right text-sm font-semibold whitespace-nowrap tabular-nums max-xl:col-start-2 max-xl:row-start-1">
        {item.amountMinor != null &&
          fee(item.amountMinor, item.monthlyFee, item.currency)}
      </span>

      {/* Блок стоит над списком и не должен его уводить: с lg строка в две линии, с xl в
          одну. На телефоне срок и кнопка идут отдельной линией: рядом с названием им тесно. */}
      <span className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 max-lg:col-span-2 lg:contents">
        <span className="flex lg:justify-end lg:max-xl:col-start-2 lg:max-xl:row-start-2">
          <Badge tone={deadline.tone}>{deadline.label}</Badge>
        </span>

        <PaidButton
          item={item}
          onPaid={onPaid}
          className="relative lg:max-xl:col-start-3 lg:max-xl:row-span-2 lg:max-xl:row-start-1 xl:w-full"
        />
      </span>
    </li>
  );
}

export { KeyRound as CredentialsIcon };
