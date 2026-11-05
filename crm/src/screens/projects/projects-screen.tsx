import { Building2, CheckSquare, Columns3, List as ListIcon, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ApiError } from "@/api/client";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import { listClients, type Client } from "@/api/clients";
import {
  archiveProject,
  CLOSED_PROJECT_STATUSES,
  createProject,
  deleteProject,
  addProjectNote,
  getProject,
  listProjects,
  PROJECT_STATUS_LABELS,
  reorderProjects,
  unarchiveProject,
  updateProject,
  workTypeLabel,
  type Project,
  type ProjectFilters,
  type ProjectStatus,
} from "@/api/projects";
import { isAdmin, useCurrentUser } from "@/auth/auth-context";
import { columnOf, useColumns } from "@/api/columns";
import { Board, type BoardColumn, type ColumnTone } from "@/components/board";
import { ColumnMenu } from "@/components/column-menu";
import { NotesPanel } from "@/components/notes-panel";
import { PersonChips } from "@/components/person-chip";
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
  Segmented,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { NoteHint } from "@/components/note-hint";
import { describeDeadline, periodLabel } from "@/lib/dates";
import {
  emptyProjectValues,
  ProjectFields,
  projectToValues,
  valuesToProjectInput,
  type ProjectFormValues,
} from "./project-form";
import { ProjectBilling, type PaymentBlock } from "./project-billing";
import { ProjectInvoices } from "./project-invoices";
import { ProjectStages } from "./project-stages";
import { ProjectView } from "./project-view";
import { hasMoney, PAYMENT_TEXT_CLASS, paymentSummary } from "./payment-summary";

const TABS = [
  { key: "all", label: "Все", filters: { scope: "all" } },
  { key: "open", label: "В работе", filters: { scope: "open" } },
  { key: "overdue", label: "Просрочено", filters: { overdue: true } },
  { key: "closed", label: "Закрытые", filters: { scope: "closed" } },
  { key: "archive", label: "Архив", filters: { archived: "only" } },
] as const satisfies readonly { key: string; label: string; filters: ProjectFilters }[];

type TabKey = (typeof TABS)[number]["key"];

/** Срез по клиенту: значения, кроме идентификаторов клиентов. */
const ALL_CLIENTS = "all";
const NO_CLIENT = "none";

const STATUS_TONE: Record<string, "neutral" | "accent" | "warning" | "success"> = {
  planned: "neutral",
  active: "accent",
  on_hold: "warning",
  done: "success",
  cancelled: "neutral",
};

/** Статус проекта названием его колонки: админ называет колонки как хочет. */
function StatusBadge({ project }: { project: Project }) {
  const columns = useColumns("project");
  return (
    <Badge tone={STATUS_TONE[project.status] ?? "neutral"}>
      {(columns && columnOf(columns, project)?.title) ??
        PROJECT_STATUS_LABELS[project.status]}
    </Badge>
  );
}

const COLUMN_TONE: Record<string, ColumnTone> = {
  planned: "neutral",
  active: "accent",
  on_hold: "warning",
  done: "success",
  cancelled: "neutral",
};

/** Колонка доски бывает уже плашки, а обрезать срок или месяц без счёта нельзя. */
const WRAPPING_BADGE = "h-auto min-h-6 py-0.5 whitespace-normal";

function isClosed(project: Project): boolean {
  return (CLOSED_PROJECT_STATUSES as readonly string[]).includes(project.status);
}

/** Сколько задач ещё открыто из всех. Мелко: это сведение, а не повод для действия. */
function TaskCount({ project }: { project: Project }) {
  if (project.taskCount === 0) return null;
  return (
    <span
      title={`Открытых задач ${project.openTaskCount} из ${project.taskCount}`}
      className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums"
    >
      <CheckSquare size={15} strokeWidth={2.25} />
      {project.openTaskCount}/{project.taskCount}
    </span>
  );
}

function Team({ names }: { names: string[] }) {
  return names.length > 0 ? (
    <PersonChips names={names} />
  ) : (
    <span className="text-muted-foreground/70 text-xs font-medium whitespace-nowrap">
      никто не ведёт
    </span>
  );
}

/**
 * Подпись этапов делится на состояние и следующий платёж. Вся она в плашку не помещается,
 * а общая у неё с карточкой клиента, поэтому деление живёт здесь.
 */
function splitPaymentLabel(label: string): { state: string; detail: string | null } {
  const at = label.indexOf(" · ");
  return at === -1
    ? { state: label, detail: null }
    : { state: label.slice(0, at), detail: label.slice(at + 3) };
}

/**
 * Как у проекта с деньгами: плашка и мелкая строка рядом. Невыставленный счёт стоит
 * первым намеренно: сдвинутый дедлайн переживём, а забытый счёт — это недополученные
 * деньги, и заметить его больше негде. Вид работы — только там, где подпись оплаты
 * о нём не говорит.
 */
function PaymentState({ project }: { project: Project }) {
  const payment = paymentSummary(project);

  if (project.unbilledPeriod) {
    return (
      <>
        <Badge tone="danger" className={WRAPPING_BADGE}>
          счёт за {periodLabel(project.unbilledPeriod)}
        </Badge>
        {payment && (
          <span className={cn("text-xs font-medium", PAYMENT_TEXT_CLASS[payment.tone])}>
            {payment.label}
          </span>
        )}
      </>
    );
  }

  if (payment) {
    const { state, detail } = splitPaymentLabel(payment.label);
    return (
      <>
        <Badge tone={payment.tone} className={WRAPPING_BADGE}>
          {state}
        </Badge>
        {detail && (
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {detail}
          </span>
        )}
      </>
    );
  }

  return project.workType ? (
    <span className="text-muted-foreground text-xs font-medium">
      {workTypeLabel(project.workType)}
    </span>
  ) : null;
}

/**
 * Карточка проекта на доске: кто, что, деньги, срок и люди. Остальное — внутри.
 * `showMoney` выключен у сотрудника: денег в его ответе нет.
 */
function ProjectCard({
  project,
  showMoney,
  onOpen,
}: {
  project: Project;
  showMoney: boolean;
  onOpen: () => void;
}) {
  const closed = isClosed(project);
  const deadline =
    project.deadline && !closed ? describeDeadline(project.deadline) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 p-3 text-left"
    >
      <span className="flex items-center justify-between gap-2">
        {/* Пустой клиент виден, а не спрятан: на доске это подсказка, что в проекте
            чего-то не хватает. */}
        <span
          className={cn(
            "text-muted-foreground min-w-0 truncate text-xs font-medium",
            !project.client && "opacity-70",
          )}
        >
          {project.client?.name ?? "без клиента"}
        </span>
        <TaskCount project={project} />
      </span>

      <span
        className={cn(
          "text-sm leading-snug font-semibold",
          closed && "text-muted-foreground",
        )}
      >
        {project.title}
      </span>

      <NoteHint note={project.note} className="mt-0" />

      {showMoney && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 empty:hidden">
          <PaymentState project={project} />
        </span>
      )}

      <span className="mt-1 flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {deadline ? (
          <Badge tone={deadline.tone} className={WRAPPING_BADGE}>
            {deadline.label}
          </Badge>
        ) : (
          <span />
        )}
        <span className="ml-auto flex">
          <Team names={project.developers} />
        </span>
      </span>
    </button>
  );
}

export function ProjectsScreen() {
  /** Сотрудник только смотрит: запись и деньги закрыты сервером, здесь их просто нет. */
  const admin = isAdmin(useCurrentUser());
  /**
   * Правит и видит деньги тот, кому их прислал сервер. Одной роли мало: в открытой вкладке
   * она остаётся прежней после понижения, а форма на проекте без денег роняет экран.
   */
  const manages = (project: Project) => admin && hasMoney(project);
  // Доской с 768px, как задачи: так их и смотрят. На телефоне перетаскивать нечем, там
  // список. Выбор не запоминается, по той же причине, что у задач.
  const [view, setView] = useState<"list" | "board">(() =>
    window.matchMedia("(min-width: 768px)").matches ? "board" : "list",
  );
  const [tab, setTab] = useState<TabKey>("all");
  const [clientFilter, setClientFilter] = useState(ALL_CLIENTS);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Колонка, из которой нажали «+» — проект заводится сразу в ней. */
  const [prefill, setPrefill] = useState<{
    columnId: string;
    status: ProjectStatus;
  } | null>(null);
  const columns = useColumns("project");
  const [editing, setEditing] = useState<Project | null>(null);
  /** Карточка, открытая ради суммы: туда сразу прокручивается блок оплаты. */
  const [revealFor, setRevealFor] = useState<string | null>(null);
  /** Фильтры переключают быстро: ответ за прошлый срез не должен лечь поверх нового. */
  const request = useRef(0);

  // На доске архива нет: у него нет колонок и порядка, поэтому вид принудительный,
  // а выбранный человеком вид возвращается вместе с другим срезом.
  const shownView = tab === "archive" ? "list" : view;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    const active = TABS.find((item) => item.key === tab) ?? TABS[0];
    // Доске нужны все колонки разом, поэтому срез вкладки на ней не применяется.
    // Клиент — другое дело: «доска одного клиента» имеет смысл.
    const filters: ProjectFilters =
      shownView === "board" ? { scope: "all" } : { ...active.filters };
    if (clientFilter !== ALL_CLIENTS) filters.clientId = clientFilter;
    if (debouncedSearch) filters.search = debouncedSearch;

    setError(null);
    const current = (request.current += 1);
    listProjects(filters)
      .then((result) => {
        if (current === request.current) setProjects(result);
      })
      .catch((cause: unknown) => {
        if (current !== request.current) return;
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setProjects([]);
      });
  }, [tab, shownView, clientFilter, debouncedSearch]);

  useEffect(load, [load]);

  /** Запись ждёт сервер, и за это время срез могли переключить: см. экран задач. */
  const latestLoad = useRef(load);
  latestLoad.current = load;

  // Архивный проект в загруженный список не входит, а из поиска, «Счетов» и
  // карточки клиента открываться обязан.
  const fetchProject = useCallback(
    (id: string) =>
      getProject(id)
        .then(({ project }) => project)
        .catch(() => null),
    [],
  );
  // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(projects, setEditing, fetchProject);

  /**
   * Блок оплаты сохраняется сам, без общей кнопки, и окно при этом остаётся
   * открытым. Форма не сбрасывается: `initial` читается только при монтировании.
   */
  const refreshOpened = useCallback((id: string) => {
    latestLoad.current();
    getProject(id)
      .then(({ project }) =>
        // Окно могли успеть закрыть, и ответ не должен открывать его заново.
        setEditing((current) => (current?.id === id ? project : current)),
      )
      .catch(() => {});
  }, []);
  useFocusFromLink(projects !== null);

  useEffect(() => {
    // Клиенты закрыты для сотрудника: запрос только дал бы 403, а срез ему не нужен.
    if (!admin) return;
    listClients()
      .then(setClients)
      .catch(() => setClients([]));
  }, [admin]);

  /**
   * Перенос карточки: сначала колонка, потом порядок колонки. Статус задаёт тип колонки,
   * его считает сервер, а здесь он ставится заранее, чтобы карточка не мигнула.
   */
  async function moveProject(columnId: string, ids: string[]) {
    const column = columns?.find((item) => item.id === columnId);
    if (!column) return;
    const status = column.kind as ProjectStatus;
    const moved = projects?.find(
      (project) =>
        ids.includes(project.id) && columnOf(columns ?? [], project)?.id !== columnId,
    );

    // Двигаем на месте до ответа сервера — иначе карточка успевает вернуться
    // в исходную колонку и мигнуть, будто перенос не принят.
    setProjects((current) =>
      current === null
        ? null
        : current.map((project) =>
            project.id === moved?.id
              ? { ...project, status, columnId, position: ids.indexOf(project.id) }
              : ids.includes(project.id)
                ? { ...project, position: ids.indexOf(project.id) }
                : project,
          ),
    );

    try {
      if (moved) await updateProject(moved.id, { columnId, status });
      await reorderProjects(columnId, ids);
      latestLoad.current();
    } catch (cause) {
      // Именно в таком порядке: `load` сбрасывает ошибку.
      latestLoad.current();
      setError(cause instanceof ApiError ? cause.message : "Не удалось перенести");
    }
  }

  return (
    <section>
      <PageHeader title="Проекты">
        {admin && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} strokeWidth={2.5} />
            Новый проект
          </Button>
        )}
      </PageHeader>

      <FilterToolbar
        filters={
          <>
            <Segmented
              value={tab}
              onChange={(value) => setTab(value as TabKey)}
              ariaLabel="Какие проекты показать"
              options={TABS.map((item) => ({ value: item.key, label: item.label }))}
            />
            {admin && (
              <Select
                value={clientFilter}
                onChange={setClientFilter}
                ariaLabel="Фильтр по клиенту"
                icon={<Building2 size={15} strokeWidth={2.25} />}
                className="bg-background shadow-card w-full rounded-xl sm:w-52"
                options={[
                  { value: ALL_CLIENTS, label: "Все клиенты" },
                  { value: NO_CLIENT, label: "Без клиента" },
                  ...clients.map((client) => ({ value: client.id, label: client.name })),
                ]}
              />
            )}
          </>
        }
        search={<SearchField value={search} onChange={setSearch} />}
        view={{
          value: shownView,
          onChange: (value) => {
            setView(value as "list" | "board");
            // Иначе нажатие на «Доска» ничего бы не сделало: архив держит список.
            if (value === "board" && tab === "archive") setTab("all");
          },
          ariaLabel: "Вид списка проектов",
          options: [
            { value: "list", label: "Список", icon: ListIcon },
            { value: "board", label: "Доска", icon: Columns3 },
          ],
        }}
      />

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {projects === null ? (
          <LoadingRows />
        ) : projects.length === 0 ? (
          <EmptyState {...emptyState(tab, clientFilter, debouncedSearch, admin)} />
        ) : shownView === "board" && !columns ? (
          <LoadingRows />
        ) : shownView === "board" ? (
          <Board
            readOnly={!admin}
            onAdd={
              admin
                ? (columnKey) => {
                    const column = columns?.find((item) => item.id === columnKey);
                    if (column) {
                      setPrefill({
                        columnId: column.id,
                        status: column.kind as ProjectStatus,
                      });
                    }
                    setCreating(true);
                  }
                : undefined
            }
            columns={
              (columns ?? []).map((column) => ({
                key: column.id,
                label: column.title,
                tone: COLUMN_TONE[column.kind],
                items: projects.filter(
                  (project) => columnOf(columns ?? [], project)?.id === column.id,
                ),
              })) satisfies BoardColumn<Project>[]
            }
            onMove={
              admin ? (columnKey, ids) => void moveProject(columnKey, ids) : undefined
            }
            {...(admin &&
              columns && {
                columnActions: (columnKey: string) => {
                  const column = columns.find((item) => item.id === columnKey);
                  return column ? (
                    <ColumnMenu column={column} columns={columns} onError={setError} />
                  ) : null;
                },
              })}
            renderCard={(project) => (
              <ProjectCard
                project={project}
                showMoney={manages(project)}
                onOpen={() => setEditing(project)}
              />
            )}
          />
        ) : (
          <List>
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                showMoney={manages(project)}
                onOpen={() => setEditing(project)}
              />
            ))}
          </List>
        )}
      </div>

      {creating && (
        <ProjectModal
          title="Новый проект"
          submitLabel="Создать проект"
          clients={clients}
          initial={{
            ...emptyProjectValues(),
            ...(prefill ?? {}),
          }}
          onClose={() => {
            setCreating(false);
            setPrefill(null);
          }}
          onSubmit={async (values) => {
            const project = await createProject(valuesToProjectInput(values));
            setCreating(false);
            setPrefill(null);
            // Сумма задаётся в карточке, поэтому туда и ведём.
            if (project.payment.mode !== "none") {
              setEditing(project);
              setRevealFor(project.id);
            }
            latestLoad.current();
          }}
        />
      )}

      {editing && !manages(editing) && (
        <ProjectView
          project={editing}
          badge={
            <>
              <StatusBadge project={editing} />
              {editing.archivedAt && <Badge>архив</Badge>}
            </>
          }
          onClose={() => setEditing(null)}
        />
      )}

      {editing && manages(editing) && (
        <ProjectModal
          title="Проект"
          badge={editing.archivedAt ? <Badge>архив</Badge> : undefined}
          clients={clients}
          project={editing}
          reveal={revealFor === editing.id}
          initial={projectToValues(editing)}
          onClose={() => {
            setEditing(null);
            setRevealFor(null);
          }}
          onChanged={() => refreshOpened(editing.id)}
          onSubmit={async (values) => {
            const project = await updateProject(editing.id, valuesToProjectInput(values));
            // Смена режима оплаты открыла новый блок: окно остаётся, иначе сумму
            // пришлось бы искать, открывая проект заново.
            const opened =
              project.payment.mode !== "none" &&
              project.payment.mode !== editing.payment.mode;
            setEditing(opened ? project : null);
            setRevealFor(opened ? project.id : null);
            latestLoad.current();
          }}
          onArchive={async () => {
            await (editing.archivedAt ? unarchiveProject : archiveProject)(editing.id);
            setEditing(null);
            latestLoad.current();
          }}
          onDelete={async () => {
            await deleteProject(editing.id);
            setEditing(null);
            latestLoad.current();
          }}
        />
      )}
    </section>
  );
}

/** Пустой список при включённом фильтре — не «заведите первый», а «тут ничего нет». */
function emptyState(
  tab: TabKey,
  clientFilter: string,
  search: string,
  admin: boolean,
): { title: string; note: string } {
  if (tab === "archive") {
    return {
      title: "В архиве пусто",
      note: "Сюда уходят проекты, которые больше не нужны на глазах. Вернуть можно в любой момент.",
    };
  }
  if (tab !== "all" || clientFilter !== ALL_CLIENTS || search) {
    return { title: "Ничего не нашлось", note: "Попробуйте другой срез или клиента." };
  }
  return admin
    ? {
        title: "Пока пусто",
        note: "Проект — это работа, у которой есть начало и конец. Заведите первый.",
      }
    : {
        title: "Пока пусто",
        note: "Здесь будут проекты, которые вы ведёте или в которых у вас есть задачи.",
      };
}

function ProjectRow({
  project,
  showMoney,
  onOpen,
}: {
  project: Project;
  showMoney: boolean;
  onOpen: () => void;
}) {
  // Срок убранного проекта никого не торопит, поэтому в архиве красной плашки нет.
  const deadline =
    project.deadline && !isClosed(project) && !project.archivedAt
      ? describeDeadline(project.deadline)
      : null;

  return (
    <li>
      {/* Колонки с xl, а не с sm: боковое меню отнимает ширину, и на меньшем экране пять
          столбцов сжали бы название до пары букв. До этого плашки идут вторым рядом.
          Столбец задан у каждой ячейки: пустой срок не должен сдвигать соседние.
          У сотрудника колонки оплаты нет: пустая съедала бы ширину названия. */}
      <button
        type="button"
        onClick={onOpen}
        data-card-id={project.id}
        className={cn(
          "hover:bg-muted/60 grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-left transition-colors",
          showMoney
            ? "xl:grid-cols-[minmax(0,1fr)_6.5rem_6rem_10rem_11rem]"
            : "xl:grid-cols-[minmax(0,1fr)_6.5rem_6rem_10rem]",
        )}
      >
        <span className="min-w-0 xl:col-start-1 xl:row-start-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[15px] font-semibold">{project.title}</span>
            <TaskCount project={project} />
          </span>
          <span className="text-muted-foreground mt-0.5 block truncate text-[13px] font-medium">
            {project.client?.name ?? "без клиента"}
          </span>
        </span>

        <span className="flex xl:col-start-3 xl:row-start-1">
          <Team names={project.developers} />
        </span>

        <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 xl:contents">
          <span className="flex xl:col-start-2 xl:row-start-1">
            <StatusBadge project={project} />
          </span>

          {deadline && (
            <span className="flex xl:col-start-4 xl:row-start-1">
              <Badge tone={deadline.tone}>{deadline.label}</Badge>
            </span>
          )}

          {showMoney && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 empty:hidden xl:col-start-5 xl:row-start-1 xl:flex-col xl:items-end xl:justify-self-end">
              <PaymentState project={project} />
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function ProjectModal({
  title,
  submitLabel = "Сохранить",
  badge,
  initial,
  clients,
  project,
  reveal,
  onClose,
  onChanged,
  onSubmit,
  onArchive,
  onDelete,
}: {
  title: string;
  submitLabel?: string;
  badge?: ReactNode;
  initial: ProjectFormValues;
  clients: Client[];
  /** Прокрутить к блоку оплаты: карточку открыли ради суммы. */
  reveal?: boolean;
  /**
   * Есть только у сохранённого проекта — счета вешать не на что, пока его нет.
   * Блоки оплаты строятся по нему, а не по значениям формы: выбранный, но не
   * сохранённый вид работы этапов ещё не создал.
   */
  project?: Project;
  onClose: () => void;
  /** Блок карточки сохранил своё без общей кнопки. */
  onChanged?: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  /** Убрать в архив либо вернуть оттуда — смотря где проект сейчас. */
  onArchive?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<ProjectFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const billingBlock = useRef<PaymentBlock>(null);
  const stagesBlock = useRef<PaymentBlock>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Блоки оплаты первыми: сумму пишет свой маршрут, а смена вида работы в этом же
      // сохранении закрыла бы его. Набранное иначе молча пропало бы с окном.
      await billingBlock.current?.flush();
      await stagesBlock.current?.flush();
      await onSubmit(values);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      // Окно может остаться открытым и после успеха: см. onSubmit у карточки.
      setSaving(false);
    }
  }

  // Без подтверждения, в отличие от удаления: архив обратим одной кнопкой.
  async function handleArchive() {
    if (!onArchive) return;
    setError(null);
    setSaving(true);
    try {
      await onArchive();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm("Удалить проект? Его задачи тоже скроются.")) return;
    setError(null);
    setSaving(true);
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setSaving(false);
    }
  }

  return (
    // Широкое только у заведённого проекта: строки этапов и счетов идут в четыре столбца,
    // а новому хватает обычной ширины, таких строк у него ещё нет.
    <Modal title={title} badge={badge} onClose={onClose} wide={Boolean(project)}>
      <form onSubmit={handleSubmit}>
        <ProjectFields
          values={values}
          onChange={setValues}
          clients={clients}
          saved={project}
        />

        {project && (
          <>
            {project.payment.mode === "monthly" && (
              <div className="mt-4">
                <ProjectBilling
                  ref={billingBlock}
                  project={project}
                  reveal={reveal}
                  onSaved={() => onChanged?.()}
                />
              </div>
            )}
            <ProjectStages
              ref={stagesBlock}
              project={project}
              reveal={reveal && project.payment.mode === "stages"}
              onChanged={() => onChanged?.()}
            />
            <div className="mt-5">
              {/* key: сохранённая сумма могла дойти до записей текущего месяца, а
                  валюта и режим читаются только при монтировании. */}
              <ProjectInvoices
                key={project.updatedAt}
                projectId={project.id}
                defaultCurrency={project.currency}
                mode={project.payment.mode}
                onChanged={onChanged}
              />
            </div>
            <div className="mt-6">
              <NotesPanel
                load={async () => (await getProject(project.id)).notes}
                add={(body) => addProjectNote(project.id, body)}
                hint="Пока пусто. Сюда — договорённости с клиентом и решения по проекту."
              />
            </div>
          </>
        )}

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : submitLabel}
          </Button>
          {onArchive && (
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              onClick={() => void handleArchive()}
              disabled={saving}
            >
              {project?.archivedAt ? "Вернуть" : "В архив"}
            </Button>
          )}
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
