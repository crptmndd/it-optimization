import {
  CalendarDays,
  Check,
  Columns3,
  Flame,
  List as ListIcon,
  Plus,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ApiError } from "@/api/client";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import { listProjects, type Project } from "@/api/projects";
import {
  BOARD_COLUMNS,
  addTaskNote,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  reorderTasks,
  TASK_STATUS_LABELS,
  updateTask,
  type Task,
  type TaskFilters,
  type TaskStatus,
} from "@/api/tasks";
import { Board, type BoardColumn, type ColumnTone } from "@/components/board";
import { NotesPanel } from "@/components/notes-panel";
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
  Modal,
  PageHeader,
  SearchField,
  SectionTitle,
  Segmented,
} from "@/components/ui";
import { daysFromToday, describeDeadline, formatDate } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { NoteHint } from "@/components/note-hint";
import {
  emptyTaskValues,
  TaskFields,
  taskToValues,
  valuesToTaskInput,
  type TaskFormValues,
} from "./task-form";

type TabKey = "open" | "overdue" | "done";

function isClosed(task: Task): boolean {
  return task.status === "done" || task.status === "cancelled";
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

/** Раньше срок, потом срочное: две задачи на один день различает важность. */
function byUrgency(left: Task, right: Task): number {
  const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Infinity;
  const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Infinity;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return (
    Number(right.priority === "high") - Number(left.priority === "high") ||
    left.position - right.position
  );
}

/** Цвет колонки — по смыслу: что ждёт, что в работе, что закрыто. */
const COLUMN_TONE: Record<string, ColumnTone> = {
  backlog: "neutral",
  todo: "accent",
  in_progress: "warning",
  done: "success",
};

/** Карточка задачи на доске: название, проект, срок и люди. Остальное — внутри. */
function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const done = isClosed(task);
  const deadline = task.dueAt && !done ? describeDeadline(task.dueAt) : null;
  const closedOn = done && task.completedAt ? formatDate(task.completedAt) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 p-3 text-left"
    >
      {task.project && (
        <span className="text-muted-foreground truncate text-xs font-medium">
          {task.project.title}
        </span>
      )}

      {/* Заголовок не обрезается: на доске карточка — единственное место, где
          видно, что за задача, и «Сверстать главную стр…» здесь бесполезно. */}
      <span
        className={cn(
          "text-sm leading-snug font-semibold",
          done && "text-muted-foreground line-through",
        )}
      >
        {task.priority === "high" && !done && (
          <Flame
            size={13}
            strokeWidth={2.5}
            aria-label="Срочно"
            className="text-danger mr-1 inline align-[-1px]"
          />
        )}
        {task.title}
      </span>

      {/* Одна строка описания: часто в ней и лежит суть. */}
      {task.description && (
        <span className="text-muted-foreground truncate text-xs">{task.description}</span>
      )}

      <NoteHint note={task.note} className="mt-0" />

      {(deadline || closedOn || task.developers.length > 0) && (
        <span className="mt-1 flex min-h-6 items-center justify-between gap-2">
          {deadline ? (
            <Badge tone={deadline.tone}>{deadline.label}</Badge>
          ) : closedOn ? (
            <span className="text-muted-foreground text-xs">{closedOn}</span>
          ) : (
            <span />
          )}
          <PersonChips names={task.developers} />
        </span>
      )}
    </button>
  );
}

export function TasksScreen() {
  const [view, setView] = useState<"list" | "board" | "calendar">("list");
  const [tab, setTab] = useState<TabKey>("open");
  const [developer, setDeveloper] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Дата из календаря — подставляется в срок новой задачи. */
  const [prefillDate, setPrefillDate] = useState("");
  /** Колонка, из которой нажали «+» — новая задача заводится сразу в ней. */
  const [prefillStatus, setPrefillStatus] = useState<TaskStatus | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

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
    Promise.all([
      listTasks({ ...filters, scope: "open" }),
      listTasks({ ...filters, scope: "closed" }),
    ])
      .then(([open, closed]) => setTasks([...open, ...closed]))
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setTasks([]);
      });
  }, [developer, debouncedSearch]);

  useEffect(load, [load]); // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(tasks, setEditing);
  // Из «Сегодня» приходят не открывать, а показать, где карточка стоит.
  useFocusFromLink(tasks !== null);

  useEffect(() => {
    // Список проектов нужен только для выпадающего списка в форме, поэтому
    // берём открытые: закрытому проекту новые задачи не заводят.
    listProjects({ scope: "open" })
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  /**
   * Перенос карточки: сначала статус, потом порядок колонки. Порядок важен —
   * сервер при смене статуса ставит задачу в конец, и перестановка обязана
   * идти после, иначе она затрётся.
   */
  async function moveTask(status: TaskStatus, ids: string[]) {
    const moved = tasks?.find((task) => ids.includes(task.id) && task.status !== status);

    // Двигаем на месте до ответа сервера. Иначе карточка на долю секунды
    // возвращается в исходную колонку и «прыгает» — выглядит как сбой, хотя
    // перенос уже принят.
    setTasks((current) =>
      current === null
        ? null
        : current.map((task) =>
            task.id === moved?.id
              ? { ...task, status, position: ids.indexOf(task.id) }
              : ids.includes(task.id)
                ? { ...task, position: ids.indexOf(task.id) }
                : task,
          ),
    );

    try {
      if (moved) await updateTask(moved.id, { status });
      await reorderTasks(status, ids);
      load();
    } catch (cause) {
      // Откат: на экране должно остаться то, что в базе. Именно в таком порядке:
      // `load` сбрасывает ошибку, и наоборот она бы исчезла, не показавшись.
      load();
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
      load();
    } catch (cause) {
      load();
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    }
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

  return (
    <section>
      <PageHeader title="Задачи">
        <Button onClick={() => setCreating(true)}>
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
            <PeopleFilter value={developer} onChange={setDeveloper} />
          </>
        }
        search={<SearchField value={search} onChange={setSearch} />}
        view={{
          value: view,
          onChange: (value) => setView(value as "list" | "board" | "calendar"),
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
        ) : nothing ? (
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
            onPickDay={(isoDate) => {
              setPrefillDate(isoDate);
              setCreating(true);
            }}
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
        ) : view === "board" ? (
          <Board
            onAdd={(columnKey) => {
              setPrefillStatus(columnKey as TaskStatus);
              setCreating(true);
            }}
            columns={
              BOARD_COLUMNS.map((status) => ({
                key: status,
                label: TASK_STATUS_LABELS[status],
                tone: COLUMN_TONE[status],
                items: tasks.filter((task) => task.status === status),
              })) satisfies BoardColumn<Task>[]
            }
            onMove={(columnKey, ids) => void moveTask(columnKey as TaskStatus, ids)}
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
          projects={projects}
          initial={{
            // Открыт срез по человеку: задачу почти наверняка заводят на него.
            ...emptyTaskValues({ developers: developer ? [developer] : [] }),
            dueDate: prefillDate,
            ...(prefillStatus ? { status: prefillStatus } : {}),
          }}
          onClose={() => {
            setCreating(false);
            setPrefillDate("");
            setPrefillStatus(null);
          }}
          onSubmit={async (values) => {
            await createTask(valuesToTaskInput(values));
            setCreating(false);
            setPrefillDate("");
            setPrefillStatus(null);
            load();
          }}
        />
      )}

      {editing && (
        <TaskModal
          title="Задача"
          projects={projects}
          current={editing.project}
          taskId={editing.id}
          editing
          initial={taskToValues(editing)}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateTask(editing.id, valuesToTaskInput(values));
            setEditing(null);
            load();
          }}
          onDelete={async () => {
            await deleteTask(editing.id);
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

/** Статус в строке только когда он что-то добавляет: «К работе» — обычное состояние. */
function statusTone(task: Task): "accent" | "neutral" | null {
  if (task.status === "in_progress") return "accent";
  if (task.status === "backlog") return "neutral";
  return null;
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
  const tone = statusTone(task);

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
          {tone && !done && (
            <Badge tone={tone} className="hidden xl:inline-flex">
              {TASK_STATUS_LABELS[task.status]}
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

function TaskModal({
  title,
  submitLabel = "Сохранить",
  initial,
  projects,
  current,
  taskId,
  editing,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  submitLabel?: string;
  initial: TaskFormValues;
  projects: Project[];
  current?: { id: string; title: string } | null;
  /** Есть только у сохранённой задачи — заметки вешать не на что, пока её нет. */
  taskId?: string;
  editing?: boolean;
  onClose: () => void;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<TaskFormValues>(initial);
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
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm("Удалить задачу?")) return;
    setError(null);
    setSaving(true);
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setSaving(false);
    }
  }

  // Из поля подробностей Enter переносит строку, поэтому отправка там по ⌘Enter.
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit} onKeyDown={onKeyDown}>
        <TaskFields
          values={values}
          onChange={setValues}
          projects={projects}
          current={current}
          editing={editing}
        />

        {taskId && (
          <div className="mt-5">
            <NotesPanel
              load={async () => (await getTask(taskId)).notes}
              add={(body) => addTaskNote(taskId, body)}
              hint="Пока пусто. Сюда — что выяснилось по ходу и почему сделано так."
            />
          </div>
        )}

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : submitLabel}
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
