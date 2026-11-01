import {
  Briefcase,
  Building2,
  CalendarDays,
  FileText,
  Filter,
  Plus,
  Receipt,
  Server,
  Wallet,
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
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  reorderProjects,
  unarchiveProject,
  updateProject,
  workTypeLabel,
  type Project,
  type ProjectFilters,
  type ProjectStatus,
} from "@/api/projects";
import { Board, type BoardColumn, type ColumnTone } from "@/components/board";
import { NotesPanel } from "@/components/notes-panel";
import { PersonChips } from "@/components/person-chip";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Modal,
  Select,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { NoteHint } from "@/components/note-hint";
import { money } from "@/lib/money";
import { describeDeadline, formatDate, periodLabel } from "@/lib/dates";
import {
  emptyProjectValues,
  ProjectFields,
  projectToValues,
  valuesToProjectInput,
  type ProjectFormValues,
} from "./project-form";
import { ProjectBilling } from "./project-billing";
import { ProjectInvoices } from "./project-invoices";
import { ProjectStages } from "./project-stages";
import { PAYMENT_TEXT_CLASS, paymentSummary } from "./payment-summary";

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

const COLUMN_TONE: Record<string, ColumnTone> = {
  planned: "neutral",
  active: "accent",
  on_hold: "warning",
  done: "success",
  cancelled: "neutral",
};

/**
 * Карточка проекта на доске.
 *
 * Заливка означает, что горит. Невыставленный счёт стоит выше срока намеренно:
 * сдвинутый дедлайн переживём, а забытый счёт — это недополученные деньги, и
 * заметить его больше негде.
 */
/**
 * Заливка означает, что горит. Невыставленный счёт стоит выше срока намеренно:
 * сдвинутый дедлайн переживём, а забытый счёт — это недополученные деньги.
 */
function projectTone(project: Project): { card: string; pill: string } {
  const closed = (CLOSED_PROJECT_STATUSES as readonly string[]).includes(project.status);
  if (closed) return { card: "bg-muted/60", pill: "bg-background text-muted-foreground" };
  if (project.unbilledPeriod) {
    return { card: "bg-danger-soft", pill: "bg-danger text-white" };
  }

  const deadline = project.deadline ? describeDeadline(project.deadline) : null;
  if (deadline?.tone === "danger") {
    return { card: "bg-danger-soft", pill: "bg-danger text-white" };
  }
  if (deadline?.tone === "warning") {
    return { card: "bg-warning-soft", pill: "bg-warning text-white" };
  }
  return { card: "bg-background", pill: "bg-muted text-muted-foreground" };
}

/** Строка сведений с иконкой. Пустое значение показывается серым, а не прячется:
 *  на доске это подсказка, что в проекте не хватает, а не мусор. */
function Meta({
  icon: Icon,
  children,
  muted,
  wrap,
}: {
  icon: typeof Building2;
  children: ReactNode;
  muted?: boolean;
  /** Переносить, а не обрезать: когда важен именно конец строки. */
  wrap?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs",
        muted ? "text-muted-foreground/60" : "text-muted-foreground",
      )}
    >
      <Icon size={12} strokeWidth={2} className="shrink-0" />
      <span className={wrap ? undefined : "truncate"}>{children}</span>
    </span>
  );
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const closed = (CLOSED_PROJECT_STATUSES as readonly string[]).includes(project.status);
  const deadline =
    project.deadline && !closed ? describeDeadline(project.deadline) : null;
  const tone = projectTone(project);
  const doneTasks = project.taskCount - project.openTaskCount;
  const payment = paymentSummary(project);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full flex-col gap-2 p-3.5 text-left", tone.card)}
    >
      {(deadline || project.unbilledPeriod) && (
        <span className="flex flex-wrap items-center gap-1.5">
          {deadline && (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                tone.pill,
              )}
            >
              <CalendarDays size={11} strokeWidth={2.5} />
              {deadline.label}
            </span>
          )}
          {project.unbilledPeriod && (
            <span className="bg-danger inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-white">
              <Wallet size={11} strokeWidth={2.5} />
              счёт за {periodLabel(project.unbilledPeriod)}
            </span>
          )}
        </span>
      )}

      <span className="text-sm leading-snug font-semibold">{project.title}</span>

      <span className="flex flex-col gap-1">
        <Meta icon={Building2} muted={!project.client}>
          {project.client?.name ?? "без клиента"}
        </Meta>

        {project.workType && (
          <Meta icon={Briefcase}>{workTypeLabel(project.workType)}</Meta>
        )}
        {project.hosting && <Meta icon={Server}>{project.hosting}</Meta>}
        {project.contractNumber && (
          <Meta icon={FileText}>
            договор {project.contractNumber}
            {project.contractDate && ` от ${formatDate(project.contractDate)}`}
          </Meta>
        )}
        {project.billingMonthly && project.monthlyAmountMinor !== null && (
          <Meta icon={Wallet}>
            {money(project.monthlyAmountMinor, project.currency)} в месяц
          </Meta>
        )}
        {payment && (
          // Колонка доски узкая, а сумма следующего этапа стоит в конце подписи.
          <Meta icon={Receipt} wrap>
            <span className={PAYMENT_TEXT_CLASS[payment.tone]}>{payment.label}</span>
          </Meta>
        )}
      </span>

      {/* Полоса выполнения вместо «задач 3/7»: доля закрытого читается мгновенно,
          а точные числа остаются подписью рядом. */}
      {project.taskCount > 0 && (
        <span className="mt-0.5 block">
          <span className="bg-foreground/10 block h-1.5 overflow-hidden rounded-full">
            <span
              className="bg-success block h-full rounded-full transition-all"
              style={{ width: `${(doneTasks / project.taskCount) * 100}%` }}
            />
          </span>
          <span className="text-muted-foreground mt-1 block text-[11px]">
            задач {doneTasks} из {project.taskCount}
          </span>
        </span>
      )}

      <span className="border-foreground/10 mt-0.5 flex min-h-6 items-center justify-between gap-2 border-t pt-2.5">
        {project.developers.length > 0 ? (
          <PersonChips names={project.developers} />
        ) : (
          <span className="text-muted-foreground/60 text-[11px]">никто не ведёт</span>
        )}
        {project.startedAt && !closed && (
          <span className="text-muted-foreground/70 text-[11px]">
            с {formatDate(project.startedAt)}
          </span>
        )}
      </span>
      <NoteHint note={project.note} />
    </button>
  );
}

export function ProjectsScreen() {
  const [view, setView] = useState<"list" | "board">("list");
  const [tab, setTab] = useState<TabKey>("all");
  const [clientFilter, setClientFilter] = useState(ALL_CLIENTS);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Колонка, из которой нажали «+» — проект заводится сразу в ней. */
  const [prefillStatus, setPrefillStatus] = useState<ProjectStatus | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
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
  const refreshOpened = useCallback(
    (id: string) => {
      load();
      getProject(id)
        .then(({ project }) =>
          // Окно могли успеть закрыть, и ответ не должен открывать его заново.
          setEditing((current) => (current?.id === id ? project : current)),
        )
        .catch(() => {});
    },
    [load],
  );
  useFocusFromLink(projects !== null);

  useEffect(() => {
    listClients()
      .then(setClients)
      .catch(() => setClients([]));
  }, []);

  /**
   * Перенос карточки: сначала статус, потом порядок колонки — сервер при смене
   * статуса ставит проект в конец, и перестановка обязана идти после.
   */
  async function moveProject(status: ProjectStatus, ids: string[]) {
    const moved = projects?.find(
      (project) => ids.includes(project.id) && project.status !== status,
    );

    // Двигаем на месте до ответа сервера — иначе карточка успевает вернуться
    // в исходную колонку и мигнуть, будто перенос не принят.
    setProjects((current) =>
      current === null
        ? null
        : current.map((project) =>
            project.id === moved?.id
              ? { ...project, status, position: ids.indexOf(project.id) }
              : ids.includes(project.id)
                ? { ...project, position: ids.indexOf(project.id) }
                : project,
          ),
    );

    try {
      if (moved) await updateProject(moved.id, { status });
      await reorderProjects(status, ids);
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось перенести");
      load();
    }
  }

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Проекты</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} strokeWidth={2.5} />
          Новый проект
        </Button>
      </header>

      {/* Та же панель, что в задачах: одинаковый по смыслу фильтр не должен
          выглядеть по-разному в соседних разделах. */}
      <FilterToolbar
        activeCount={(tab === "all" ? 0 : 1) + (clientFilter === ALL_CLIENTS ? 0 : 1)}
        view={{
          value: shownView,
          onChange: (value) => {
            setView(value as "list" | "board");
            // Иначе нажатие на «Доска» ничего бы не сделало: архив держит список.
            if (value === "board" && tab === "archive") setTab("all");
          },
          ariaLabel: "Вид списка проектов",
          options: [
            { value: "list", label: "Список" },
            { value: "board", label: "Доска" },
          ],
        }}
        filters={[
          {
            label: "Срез",
            render: (full) => (
              <Select
                value={tab}
                onChange={(value) => setTab(value as TabKey)}
                ariaLabel="Фильтр проектов"
                icon={<Filter size={14} strokeWidth={2} />}
                className={full ? "w-full" : "w-40"}
                options={TABS.map((item) => ({ value: item.key, label: item.label }))}
              />
            ),
          },
          {
            label: "Клиент",
            render: (full) => (
              <Select
                value={clientFilter}
                onChange={setClientFilter}
                ariaLabel="Фильтр по клиенту"
                icon={<Building2 size={14} strokeWidth={2} />}
                className={full ? "w-full" : "w-52"}
                options={[
                  { value: ALL_CLIENTS, label: "Все клиенты" },
                  { value: NO_CLIENT, label: "Без клиента" },
                  ...clients.map((client) => ({ value: client.id, label: client.name })),
                ]}
              />
            ),
          },
        ]}
        search={
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск"
            className="w-full sm:w-56"
          />
        }
      />

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 sm:mt-5">
        {projects === null ? (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
        ) : projects.length === 0 ? (
          <EmptyState {...emptyState(tab, clientFilter, debouncedSearch)} />
        ) : shownView === "board" ? (
          <Board
            onAdd={(columnKey) => {
              setPrefillStatus(columnKey as ProjectStatus);
              setCreating(true);
            }}
            columns={
              PROJECT_STATUSES.map((status) => ({
                key: status,
                label: PROJECT_STATUS_LABELS[status],
                tone: COLUMN_TONE[status],
                items: projects.filter((project) => project.status === status),
              })) satisfies BoardColumn<Project>[]
            }
            onMove={(columnKey, ids) => void moveProject(columnKey as ProjectStatus, ids)}
            renderCard={(project) => (
              <ProjectCard project={project} onOpen={() => setEditing(project)} />
            )}
          />
        ) : (
          <ul className="space-y-3 sm:space-y-2">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onOpen={() => setEditing(project)}
              />
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <ProjectModal
          title="Новый проект"
          clients={clients}
          initial={{
            ...emptyProjectValues(),
            ...(prefillStatus ? { status: prefillStatus } : {}),
          }}
          onClose={() => {
            setCreating(false);
            setPrefillStatus(null);
          }}
          onSubmit={async (values) => {
            const project = await createProject(valuesToProjectInput(values));
            setCreating(false);
            setPrefillStatus(null);
            // Сумма задаётся в карточке, поэтому туда и ведём.
            if (project.payment.mode !== "none") setEditing(project);
            load();
          }}
        />
      )}

      {editing && (
        <ProjectModal
          title="Проект"
          badge={editing.archivedAt ? <Badge>архив</Badge> : undefined}
          clients={clients}
          project={editing}
          initial={projectToValues(editing)}
          onClose={() => setEditing(null)}
          onChanged={() => refreshOpened(editing.id)}
          onSubmit={async (values) => {
            const project = await updateProject(editing.id, valuesToProjectInput(values));
            // Смена режима оплаты открыла новый блок: окно остаётся, иначе сумму
            // пришлось бы искать, открывая проект заново.
            const opened =
              project.payment.mode !== "none" &&
              project.payment.mode !== editing.payment.mode;
            setEditing(opened ? project : null);
            load();
          }}
          onArchive={async () => {
            await (editing.archivedAt ? unarchiveProject : archiveProject)(editing.id);
            setEditing(null);
            load();
          }}
          onDelete={async () => {
            await deleteProject(editing.id);
            setEditing(null);
            load();
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
  return {
    title: "Пока пусто",
    note: "Проект — это работа, у которой есть начало и конец. Заведите первый.",
  };
}

function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const closed = (CLOSED_PROJECT_STATUSES as readonly string[]).includes(project.status);
  // Срок убранного проекта никого не торопит, поэтому в архиве красной плашки нет.
  const deadline =
    project.deadline && !closed && !project.archivedAt
      ? describeDeadline(project.deadline)
      : null;
  const payment = paymentSummary(project);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-card-id={project.id}
        className="border-border bg-background hover:border-accent-border flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition hover:shadow-sm sm:py-2.5"
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{project.title}</span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {[
              project.client?.name,
              project.developers.length
                ? project.developers.join(", ")
                : "никто не ведёт",
              workTypeLabel(project.workType) || null,
              project.taskCount > 0
                ? `задач ${project.openTaskCount}/${project.taskCount}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {payment && (
            <span
              className={cn(
                "mt-0.5 block truncate text-xs",
                PAYMENT_TEXT_CLASS[payment.tone],
              )}
            >
              {payment.label}
            </span>
          )}
        </div>

        {project.unbilledPeriod && (
          <Badge tone="danger" className="mt-0.5">
            счёт за {periodLabel(project.unbilledPeriod)}
          </Badge>
        )}
        {deadline && (
          <Badge tone={deadline.tone} className="mt-0.5">
            {deadline.label}
          </Badge>
        )}
        <Badge tone={STATUS_TONE[project.status] ?? "neutral"} className="mt-0.5">
          {PROJECT_STATUS_LABELS[project.status]}
        </Badge>
      </button>
    </li>
  );
}

function ProjectModal({
  title,
  badge,
  initial,
  clients,
  project,
  onClose,
  onChanged,
  onSubmit,
  onArchive,
  onDelete,
}: {
  title: string;
  badge?: ReactNode;
  initial: ProjectFormValues;
  clients: Client[];
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
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
    <Modal title={title} badge={badge} onClose={onClose}>
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
                <ProjectBilling project={project} onSaved={() => onChanged?.()} />
              </div>
            )}
            <ProjectStages project={project} onChanged={() => onChanged?.()} />
            <div className="mt-4">
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
            <div className="mt-4">
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

        {/* flex-wrap: четыре кнопки на телефоне в один ряд не встают. */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          {onArchive && (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto"
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
              className={onArchive ? undefined : "ml-auto"}
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
