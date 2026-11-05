import {
  CalendarDays,
  Check,
  Columns3,
  Flame,
  List as ListIcon,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import { listProjects, type Project } from "@/api/projects";
import { columnOf, useColumns } from "@/api/columns";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  reorderTasks,
  TASK_STATUS_LABELS,
  updateTask,
  type SubtaskProgress,
  type Task,
  type TaskFilters,
  type TaskStatus,
} from "@/api/tasks";
import { isAdmin, useCurrentUser } from "@/auth/auth-context";
import { Board, type BoardColumn, type ColumnTone } from "@/components/board";
import { ColumnMenu } from "@/components/column-menu";
import { PeopleFilter } from "@/components/people-filter";
import { PersonChip, PersonChips } from "@/components/person-chip";
import { MonthCalendar } from "@/components/month-calendar";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  PageHeader,
  SearchField,
  SectionTitle,
  Segmented,
} from "@/components/ui";
import { daysFromToday, describeDeadline, formatDate } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { ProjectBoard } from "./project-board";
import { saveDraftSubtasks } from "./subtasks";
import { byUrgency, isClosed, statusBadge, SubtaskCount, TaskCard } from "./task-card";
import {
  emptyTaskValues,
  taskToValues,
  valuesToTaskInput,
  type TaskFormValues,
} from "./task-form";
import { TaskModal } from "./task-modal";

type TabKey = "open" | "overdue" | "done";
type TaskView = "list" | "board" | "calendar";
type BoardBy = "status" | "projects";

const BOARD_BY_KEY = "crm.tasks.boardBy";

/** Перетаскивания на телефоне нет, поэтому там первым открывается список. */
function defaultView(): TaskView {
  return window.matchMedia("(min-width: 768px)").matches ? "board" : "list";
}

function readBoardBy(): BoardBy {
  try {
    return localStorage.getItem(BOARD_BY_KEY) === "projects" ? "projects" : "status";
  } catch {
    return "status";
  }
}

function writeBoardBy(value: BoardBy) {
  try {
    localStorage.setItem(BOARD_BY_KEY, value);
  } catch {
    // Хранилище закрыто: выбор продержится до обновления страницы, и это не беда.
  }
}

function isOverdue(task: Task): boolean {
  return !isClosed(task) && task.dueAt !== null && daysFromToday(task.dueAt) < 0;
}

/**
 * Группы по сроку: список отвечает на «что делать сейчас», а не показывает задачи в
 * порядке колонок доски. Просроченное наверху, бессрочное внизу.
 */
const GROUPS = [
  { key: "overdue", title: "Просрочено", tone: "danger" },
  { key: "today", title: "Сегодня" },
  { key: "week", title: "Ближайшие 7 дней" },
  { key: "later", title: "Позже" },
  { key: "none", title: "Без срока" },
  // Только при поиске: найденная закрытая задача не должна выглядеть пропавшей.
  { key: "closed", title: "Закрытые" },
] as const;

type GroupKey = (typeof GROUPS)[number]["key"];

function groupOf(task: Task): GroupKey {
  if (isClosed(task)) return "closed";
  if (task.dueAt === null) return "none";
  const days = daysFromToday(task.dueAt);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  return days <= 7 ? "week" : "later";
}

/** Цвет колонки — по смыслу: что ждёт, что в работе, что закрыто. */
const COLUMN_TONE: Record<string, ColumnTone> = {
  todo: "accent",
  in_progress: "warning",
  done: "success",
};

export function TasksScreen() {
  const user = useCurrentUser();
  const [view, setView] = useState<TaskView>(defaultView);
  const [boardBy, setBoardBy] = useState<BoardBy>(readBoardBy);
  const [tab, setTab] = useState<TabKey>("open");
  const [developer, setDeveloper] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const columns = useColumns("task");
  /** Колонками управляет админ; сотрудник только двигает свои задачи по ним. */
  const admin = isAdmin(user);
  /** `null` — неизвестно: ещё не загрузились или не загрузились вовсе. */
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Открытое окно новой задачи и что в нём уже заполнено: дата из календаря или колонка,
   * из которой нажали «+». `null` — окно закрыто.
   */
  const [creating, setCreating] = useState<Partial<TaskFormValues> | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  /** С чем открыть правку: задача создалась, а её подзадачи нет. */
  const [editingNotice, setEditingNotice] = useState<string | null>(null);
  /** Человека переключают быстро: ответ за прошлого не должен лечь поверх нового. */
  const request = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Загружаются все задачи, а срез считается здесь. Задач сотни, а не тысячи, зато
   * вкладки переключаются мгновенно и рядом с ними можно показать числа.
   */
  const load = useCallback(() => {
    const filters: TaskFilters = {};
    if (developer) filters.developer = developer;
    if (debouncedSearch) filters.search = debouncedSearch;

    // Двумя запросами: у сервера потолок в 1000 строк, и общим списком он срезал бы
    // свежие закрытые, потому что они идут в конце.
    setError(null);
    const current = (request.current += 1);
    Promise.all([
      listTasks({ ...filters, scope: "open" }),
      listTasks({ ...filters, scope: "closed" }),
    ])
      .then(([open, closed]) => {
        if (current === request.current) setTasks([...open, ...closed]);
      })
      .catch((cause: unknown) => {
        if (current !== request.current) return;
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        // Уже показанное остаётся: сбой связи не значит, что задач больше нет.
        setTasks((shown) => shown ?? []);
      });
  }, [developer, debouncedSearch]);

  useEffect(load, [load]);

  /**
   * Запись ждёт ответ сервера, и за это время срез могли переключить. Перезагрузка идёт
   * по текущему: прежняя функция вернула бы на экран задачи того, кого уже сняли с выбора.
   */
  const latestLoad = useRef(load);
  latestLoad.current = load;

  // Задачи может не быть в загруженном списке: её скрывает срез по человеку.
  const fetchTask = useCallback(
    (id: string) =>
      getTask(id)
        .then(({ task }) => task)
        .catch(() => null),
    [],
  );
  // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(tasks, setEditing, fetchTask);
  // Из «Сегодня» приходят не открывать, а показать, где карточка стоит.
  useFocusFromLink(tasks !== null);

  useEffect(() => {
    // Открытые: в выборе формы закрытого проекта нет. Его колонка на доске бывает, и окно
    // из её «+» получает проект через `current`.
    listProjects({ scope: "open" })
      .then(setProjects)
      .catch(() => setProjects(null));
  }, []);

  /**
   * Перенос карточки: сначала колонка, потом порядок колонки. Порядок важен —
   * сервер при смене колонки ставит задачу в конец, и перестановка обязана
   * идти после, иначе она затрётся. Статус задаёт тип колонки, его считает сервер,
   * а здесь он ставится заранее, чтобы карточка не мигнула в старом виде.
   */
  async function moveTask(columnId: string, ids: string[]) {
    const column = columns?.find((item) => item.id === columnId);
    if (!column) return;
    const status = column.kind as TaskStatus;
    const moved = tasks?.find(
      (task) => ids.includes(task.id) && columnOf(columns ?? [], task)?.id !== columnId,
    );

    // Двигаем на месте до ответа сервера. Иначе карточка на долю секунды
    // возвращается в исходную колонку и «прыгает» — выглядит как сбой, хотя
    // перенос уже принят.
    setTasks((current) =>
      current === null
        ? null
        : current.map((task) =>
            task.id === moved?.id
              ? { ...task, status, columnId, position: ids.indexOf(task.id) }
              : ids.includes(task.id)
                ? { ...task, position: ids.indexOf(task.id) }
                : task,
          ),
    );

    try {
      if (moved) await updateTask(moved.id, { columnId, status });
      await reorderTasks(columnId, ids);
      latestLoad.current();
    } catch (cause) {
      // Откат: на экране должно остаться то, что в базе. Именно в таком порядке:
      // `load` сбрасывает ошибку, и наоборот она бы исчезла, не показавшись.
      latestLoad.current();
      setError(cause instanceof ApiError ? cause.message : "Не удалось перенести");
    }
  }

  /** Перенос между проектами. Подзадачи сервер переведёт в новый проект сам. */
  async function moveToProject(moved: Task, project: Task["project"]) {
    setTasks(
      (current) =>
        current?.map((task) => (task.id === moved.id ? { ...task, project } : task)) ??
        null,
    );

    try {
      await updateTask(moved.id, { projectId: project?.id ?? null });
      latestLoad.current();
    } catch (cause) {
      // Тот же порядок, что в `moveTask`: `load` сбрасывает ошибку.
      latestLoad.current();
      setError(cause instanceof ApiError ? cause.message : "Не удалось перенести");
    }
  }

  async function toggleDone(task: Task) {
    // Отменённая возвращается в работу, а не становится выполненной: кнопка обещает это.
    const next = isClosed(task) ? "todo" : "done";
    // Меняем сразу на месте: галочка должна отзываться мгновенно, иначе список
    // «моргает» на каждый клик.
    setTasks((current) =>
      current === null
        ? null
        : current.map((item) => (item.id === task.id ? { ...item, status: next } : item)),
    );
    try {
      await updateTask(task.id, { status: next });
      latestLoad.current();
    } catch (cause) {
      latestLoad.current();
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    }
  }

  /** Постоянная: окно подзадач зовёт её из эффекта, а новая функция звала бы его снова. */
  const showProgress = useCallback((taskId: string, subtasks: SubtaskProgress) => {
    setTasks(
      (current) =>
        current?.map((task) => (task.id === taskId ? { ...task, subtasks } : task)) ??
        null,
    );
  }, []);

  /** Родитель, потом подзадачи: если они не сохранятся, задача останется и откроется. */
  async function createWithSubtasks(values: TaskFormValues, subtasks: string[]) {
    const task = await createTask(valuesToTaskInput(values));
    const lost = await saveDraftSubtasks(task.id, subtasks);

    setCreating(null);
    if (lost.length > 0) {
      const titles = lost.map((title) => `«${title}»`).join(", ");
      setEditingNotice(`Задача создана, но подзадачи не сохранились: ${titles}.`);
      setEditing(task);
    }
    latestLoad.current();
  }

  const counts = useMemo(
    () => ({
      open: tasks?.filter((task) => !isClosed(task)).length ?? 0,
      overdue: tasks?.filter(isOverdue).length ?? 0,
    }),
    [tasks],
  );

  const shown = useMemo(() => {
    if (!tasks) return [];
    if (tab === "overdue") return tasks.filter(isOverdue);
    if (tab === "open") {
      // Поиск идёт по всему: закрытая задача иначе ответила бы «Ничего не нашлось», и
      // человек завёл бы её второй раз.
      return debouncedSearch ? tasks : tasks.filter((task) => !isClosed(task));
    }
    return tasks
      .filter(isClosed)
      .sort((left, right) =>
        (right.completedAt ?? "").localeCompare(left.completedAt ?? ""),
      );
  }, [tasks, tab, debouncedSearch]);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: shown.filter((task) => groupOf(task) === group.key).sort(byUrgency),
      })).filter((group) => group.items.length > 0),
    [shown],
  );

  // На доске и в календаре видно всё сразу, срез там ничего бы не значил.
  const nothing = view === "list" ? shown.length === 0 : tasks?.length === 0;

  /** Открыт срез по человеку — на него. Сотрудник видит только своё — на себя. */
  const assignees = developer
    ? [developer]
    : !isAdmin(user) && user.memberName
      ? [user.memberName]
      : [];

  return (
    <section>
      <PageHeader title="Задачи">
        <Button onClick={() => setCreating({})}>
          <Plus size={17} strokeWidth={2.5} />
          Новая задача
        </Button>
      </PageHeader>

      <FilterToolbar
        filters={
          <>
            {view === "list" && (
              <Segmented
                value={tab}
                onChange={(value) => setTab(value as TabKey)}
                ariaLabel="Какие задачи показать"
                options={[
                  { value: "open", label: "Открытые", count: counts.open },
                  { value: "overdue", label: "Просрочено", count: counts.overdue },
                  { value: "done", label: "Готово" },
                ]}
              />
            )}
            {view === "board" && (
              <Segmented
                value={boardBy}
                onChange={(value) => {
                  setBoardBy(value as BoardBy);
                  writeBoardBy(value as BoardBy);
                }}
                ariaLabel="Как разложить доску"
                options={[
                  { value: "status", label: "По статусам" },
                  { value: "projects", label: "По проектам" },
                ]}
              />
            )}
            <PeopleFilter value={developer} onChange={setDeveloper} />
          </>
        }
        search={<SearchField value={search} onChange={setSearch} />}
        view={{
          value: view,
          onChange: (value) => setView(value as TaskView),
          ariaLabel: "Вид списка задач",
          options: [
            { value: "list", label: "Список", icon: ListIcon },
            { value: "board", label: "Доска", icon: Columns3 },
            { value: "calendar", label: "Календарь", icon: CalendarDays },
          ],
        }}
      />

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {tasks === null ? (
          <LoadingRows />
        ) : nothing && error ? null : nothing ? (
          <EmptyState
            title={
              debouncedSearch || developer
                ? "Ничего не нашлось"
                : tab === "overdue" && view === "list"
                  ? "Ничего не горит"
                  : "Пока пусто"
            }
            note={
              debouncedSearch || developer
                ? "Попробуйте другой запрос или человека."
                : tab === "overdue" && view === "list"
                  ? "Задач с истёкшим сроком нет."
                  : "Заведите первую задачу — кнопка справа сверху."
            }
          />
        ) : view === "calendar" ? (
          <MonthCalendar
            items={tasks}
            dateOf={(task) => task.dueAt}
            onPickDay={(dueDate) => setCreating({ dueDate })}
            renderItem={(task) => {
              const done = task.status === "done" || task.status === "cancelled";
              const late = !done && task.dueAt && describeDeadline(task.dueAt).tone;
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setEditing(task)}
                  title={`${task.title}${task.developers.length ? ` · ${task.developers.join(", ")}` : ""}`}
                  className={cn(
                    "flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] transition",
                    done
                      ? "text-muted-foreground line-through"
                      : late === "danger"
                        ? "bg-danger-soft text-danger hover:brightness-95"
                        : late === "warning"
                          ? "bg-warning-soft text-warning hover:brightness-95"
                          : "bg-muted hover:bg-accent-soft",
                  )}
                >
                  {task.developers[0] && (
                    <PersonChip
                      name={task.developers[0]}
                      className="size-4 text-[9px] ring-0"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                </button>
              );
            }}
          />
        ) : view === "board" && boardBy === "projects" ? (
          <ProjectBoard
            tasks={tasks}
            onMove={(task, project) => void moveToProject(task, project)}
            onAdd={(projectId) => setCreating({ projectId: projectId ?? "" })}
            onOpen={setEditing}
          />
        ) : view === "board" && !columns ? (
          // Колонки грузятся отдельно от задач: без них доска была бы пустой без причины.
          <LoadingRows />
        ) : view === "board" ? (
          <Board
            onAdd={(columnKey) => {
              const column = columns?.find((item) => item.id === columnKey);
              setCreating({ columnId: columnKey, status: column?.kind as TaskStatus });
            }}
            columns={
              (columns ?? []).map((column) => ({
                key: column.id,
                label: column.title,
                tone: COLUMN_TONE[column.kind],
                // По `position`: перенос меняет его сразу, а порядок ответа сервера
                // устарел бы до следующей загрузки, и карточка отскочила бы назад.
                items: tasks
                  .filter((task) => columnOf(columns ?? [], task)?.id === column.id)
                  .sort((left, right) => left.position - right.position),
              })) satisfies BoardColumn<Task>[]
            }
            onMove={(columnKey, ids) => void moveTask(columnKey, ids)}
            {...(admin &&
              columns && {
                columnActions: (columnKey: string) => {
                  const column = columns.find((item) => item.id === columnKey);
                  return column ? (
                    <ColumnMenu column={column} columns={columns} onError={setError} />
                  ) : null;
                },
              })}
            renderCard={(task) => (
              <TaskCard task={task} onOpen={() => setEditing(task)} />
            )}
          />
        ) : tab === "done" ? (
          <List>
            {shown.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={() => void toggleDone(task)}
                onOpen={() => setEditing(task)}
              />
            ))}
          </List>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.key}>
                <SectionTitle
                  title={group.title}
                  count={group.items.length}
                  tone={"tone" in group ? group.tone : undefined}
                />
                <List>
                  {group.items.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onToggle={() => void toggleDone(task)}
                      onOpen={() => setEditing(task)}
                    />
                  ))}
                </List>
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <TaskModal
          title="Новая задача"
          submitLabel="Создать задачу"
          projects={projects ?? []}
          // Колонка закрытого проекта есть на доске, а в списке открытых его нет.
          current={
            creating.projectId
              ? (tasks?.find((task) => task.project?.id === creating.projectId)
                  ?.project ?? null)
              : null
          }
          initial={{ ...emptyTaskValues({ developers: assignees }), ...creating }}
          onClose={() => setCreating(null)}
          onSubmit={createWithSubtasks}
          onProgress={showProgress}
        />
      )}

      {editing && (
        <TaskModal
          title="Задача"
          projects={projects ?? []}
          current={editing.project}
          taskId={editing.id}
          editing
          notice={editingNotice}
          initial={taskToValues(editing)}
          onClose={() => {
            setEditing(null);
            setEditingNotice(null);
            // В окне всё сохраняется сразу: подзадачи и заметки уже изменили карточку.
            latestLoad.current();
          }}
          onSubmit={async (values) => {
            try {
              await updateTask(editing.id, valuesToTaskInput(values));
            } catch (cause) {
              // Сотрудник снял себя с подзадачи, через которую видел задачу: сохранять
              // больше нечего, и это не ошибка, а исчезнувшая из списка карточка.
              if (!(cause instanceof ApiError) || cause.status !== 404) throw cause;
            }
            setEditing(null);
            setEditingNotice(null);
            latestLoad.current();
          }}
          onDelete={async () => {
            await deleteTask(editing.id);
            setEditing(null);
            setEditingNotice(null);
            latestLoad.current();
          }}
          onProgress={showProgress}
        />
      )}
    </section>
  );
}

/**
 * Колонки появляются с `xl`, а не с `sm`: с 768 рядом уже стоит боковое меню, и на
 * планшете название сжималось до нуля. Ниже срок и проект идут второй строкой.
 */
function TaskRow({
  task,
  onToggle,
  onOpen,
}: {
  task: Task;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const done = isClosed(task);
  const deadline = task.dueAt && !done ? describeDeadline(task.dueAt) : null;
  const badge = statusBadge(task, useColumns("task"));

  return (
    <li
      data-card-id={task.id}
      className="hover:bg-muted/60 flex items-stretch transition-colors"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? "Вернуть в работу" : "Отметить выполненной"}
        className="group flex w-12 shrink-0 items-center justify-center pl-1"
      >
        <span
          className={cn(
            "flex size-[22px] items-center justify-center rounded-full transition",
            task.status === "done"
              ? "bg-accent text-accent-foreground"
              : task.status === "cancelled"
                ? "bg-disabled text-muted-foreground"
                : "ring-foreground/20 group-hover:ring-foreground/50 group-hover:text-muted-foreground text-transparent ring-2 ring-inset",
          )}
        >
          {task.status === "cancelled" ? (
            <X size={14} strokeWidth={3} />
          ) : (
            <Check size={14} strokeWidth={3} />
          )}
        </span>
      </button>

      <button
        type="button"
        onClick={onOpen}
        className="grid min-h-14 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 pr-4 text-left xl:grid-cols-[minmax(0,1fr)_12rem_3.5rem_9.75rem]"
      >
        <span className="flex min-w-0 items-center gap-2">
          {task.priority === "high" && !done && (
            <Flame
              size={15}
              strokeWidth={2.5}
              aria-label="Срочно"
              className="text-danger shrink-0"
            />
          )}
          <span
            className={cn(
              "truncate text-[15px] font-semibold",
              done && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          <SubtaskCount subtasks={task.subtasks} />
          {badge && (
            <Badge tone={badge.tone} className="hidden xl:inline-flex">
              {badge.label}
            </Badge>
          )}
          {task.status === "cancelled" && (
            <Badge>{TASK_STATUS_LABELS[task.status]}</Badge>
          )}
        </span>

        <span className="text-muted-foreground hidden truncate text-[13px] font-medium xl:block">
          {task.project?.title}
        </span>

        <span className="row-span-2 flex justify-end xl:row-span-1">
          {task.developers.length > 0 ? (
            <PersonChips names={task.developers} />
          ) : (
            <span className="text-muted-foreground text-xs">ничья</span>
          )}
        </span>

        <span className="col-start-1 mt-0.5 flex min-w-0 items-center gap-2 empty:hidden xl:col-start-auto xl:mt-0 xl:justify-end">
          {deadline ? (
            <Badge tone={deadline.tone}>{deadline.label}</Badge>
          ) : done && task.completedAt ? (
            <span className="text-muted-foreground text-xs">
              {formatDate(task.completedAt)}
            </span>
          ) : null}
          {task.project && (
            <span className="text-muted-foreground truncate text-xs font-medium xl:hidden">
              {task.project.title}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
