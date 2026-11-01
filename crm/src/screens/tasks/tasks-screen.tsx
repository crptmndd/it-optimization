import {
  AlignLeft,
  CalendarDays,
  Check,
  Filter,
  Flame,
  FolderOpen,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import { PersonChip, PersonChips } from "@/components/person-chip";
import { MonthCalendar } from "@/components/month-calendar";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Modal,
  Select,
} from "@/components/ui";
import { describeDeadline, formatDate } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { NoteHint } from "@/components/note-hint";
import { DEVELOPERS } from "@/lib/developers";
import {
  emptyTaskValues,
  TaskFields,
  taskToValues,
  valuesToTaskInput,
  type TaskFormValues,
} from "./task-form";

/**
 * Срезы списка. Вкладки «Мои» нет намеренно: исполнители значатся именами, а не
 * учётными записями, поэтому связать вошедшего с именем нельзя. Вместо неё —
 * выбор исполнителя рядом с поиском.
 */
const TABS = [
  { key: "all", label: "Все", filters: { scope: "all" } },
  { key: "overdue", label: "Просрочено", filters: { overdue: true } },
  { key: "open", label: "Открытые", filters: { scope: "open" } },
  { key: "done", label: "Готово", filters: { scope: "closed" } },
] as const satisfies readonly { key: string; label: string; filters: TaskFilters }[];

type TabKey = (typeof TABS)[number]["key"];

/** Цвет колонки — по смыслу: что ждёт, что в работе, что закрыто. */
const COLUMN_TONE: Record<string, ColumnTone> = {
  backlog: "neutral",
  todo: "accent",
  in_progress: "warning",
  done: "success",
};

/**
 * Карточка задачи на доске.
 *
 * Заливка всей карточки, а не полоска сбоку: в колонке из десятка карточек
 * взгляд цепляется за пятно, а не за четыре пикселя у края. Цвет означает
 * срочность и берётся по худшему из условий — просрочено важнее «сегодня»,
 * «сегодня» важнее высокого приоритета.
 */
/**
 * Заливка всей карточки, а не полоска сбоку: в колонке из десятка карточек
 * взгляд цепляется за пятно. Цвет означает срочность и берётся по худшему из
 * условий — просрочено важнее «сегодня», «сегодня» важнее приоритета.
 */
function taskTone(task: Task): { card: string; pill: string } {
  const done = task.status === "done" || task.status === "cancelled";
  if (done) return { card: "bg-muted/60", pill: "bg-background text-muted-foreground" };

  const deadline = task.dueAt ? describeDeadline(task.dueAt) : null;
  if (deadline?.tone === "danger") {
    return { card: "bg-danger-soft", pill: "bg-danger text-white" };
  }
  if (deadline?.tone === "warning") {
    return { card: "bg-warning-soft", pill: "bg-warning text-white" };
  }
  if (task.priority === "high") {
    return { card: "bg-accent-soft", pill: "bg-background text-foreground" };
  }
  return { card: "bg-background", pill: "bg-muted text-muted-foreground" };
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const done = task.status === "done" || task.status === "cancelled";
  const deadline = task.dueAt && !done ? describeDeadline(task.dueAt) : null;
  const tone = taskTone(task);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full flex-col gap-2 p-3.5 text-left", tone.card)}
    >
      <span className="flex flex-wrap items-center gap-1.5">
        {task.dueAt && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
              tone.pill,
            )}
          >
            <CalendarDays size={11} strokeWidth={2.5} />
            {deadline ? deadline.label : formatDate(task.dueAt)}
          </span>
        )}
        {task.priority === "high" && !done && (
          <span className="bg-danger inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-white">
            <Flame size={11} strokeWidth={2.5} />
            срочно
          </span>
        )}
        {task.priority === "low" && !done && (
          <span className="text-muted-foreground/70 text-[11px]">не срочно</span>
        )}
      </span>

      {/* Заголовок не обрезается: на доске карточка — единственное место, где
          видно, что за задача, и «Сверстать главную стр…» здесь бесполезно. */}
      <span
        className={cn(
          "text-sm leading-snug font-semibold",
          done && "text-muted-foreground line-through",
        )}
      >
        {task.title}
      </span>

      <span className="flex flex-col gap-1">
        <Meta icon={FolderOpen} muted={!task.project}>
          {task.project?.title ?? "без проекта"}
        </Meta>
        {task.description && (
          // Одна строка описания: часто в ней и лежит суть, а открывать
          // карточку ради неё — лишний клик.
          <Meta icon={AlignLeft}>{task.description}</Meta>
        )}
      </span>

      <span className="border-foreground/10 mt-0.5 flex min-h-6 items-center justify-between gap-2 border-t pt-2.5">
        {task.developers.length > 0 ? (
          <PersonChips names={task.developers} />
        ) : (
          <span className="text-muted-foreground/60 text-[11px]">ничья</span>
        )}
        {done && task.completedAt && (
          <span className="text-muted-foreground/70 text-[11px]">
            {formatDate(task.completedAt)}
          </span>
        )}
      </span>
      <NoteHint note={task.note} />
    </button>
  );
}

/** Строка сведений с иконкой; пустое значение показывается серым, а не прячется. */
function Meta({
  icon: Icon,
  children,
  muted,
}: {
  icon: typeof FolderOpen;
  children: ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs",
        muted ? "text-muted-foreground/60" : "text-muted-foreground",
      )}
    >
      <Icon size={12} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function TasksScreen() {
  const [view, setView] = useState<"list" | "board" | "calendar">("list");
  const [tab, setTab] = useState<TabKey>("all");
  /** Фильтр по исполнителю: «мои» без учётных записей не выразить. */
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

  const load = useCallback(() => {
    const active = TABS.find((item) => item.key === tab) ?? TABS[0];
    // Доске нужны все колонки разом, поэтому срез вкладки на ней не применяется.
    // Доске и календарю нужны все задачи разом, поэтому срез вкладки на них
    // не применяется: колонка «Готово» и прошлые сроки должны быть видны.
    const filters: TaskFilters =
      view === "list" ? { ...active.filters } : { scope: "all" };
    if (developer) filters.developer = developer;
    if (debouncedSearch) filters.search = debouncedSearch;

    setError(null);
    listTasks(filters)
      .then(setTasks)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setTasks([]);
      });
  }, [tab, view, developer, debouncedSearch]);

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
      setError(cause instanceof ApiError ? cause.message : "Не удалось перенести");
      // Откат: перечитываем, чтобы на экране осталось то, что реально в базе.
      load();
    }
  }

  async function toggleDone(task: Task) {
    const next = task.status === "done" ? "todo" : "done";
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
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      load();
    }
  }

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Задачи</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} strokeWidth={2.5} />
          Новая задача
        </Button>
      </header>

      {/* Срезы и исполнитель — фильтры, а не разделы, поэтому выпадающими
          списками: ряд кнопок занимал целую строку и на телефоне переносился на
          две, оставляя переключатель вида где-то посередине. */}
      <FilterToolbar
        activeCount={(tab === "all" ? 0 : 1) + (developer ? 1 : 0)}
        view={{
          value: view,
          onChange: (value) => setView(value as "list" | "board" | "calendar"),
          ariaLabel: "Вид списка задач",
          options: [
            { value: "list", label: "Список" },
            { value: "board", label: "Доска" },
            { value: "calendar", label: "Календарь" },
          ],
        }}
        filters={[
          {
            label: "Срез",
            render: (full) => (
              <Select
                value={tab}
                onChange={(value) => setTab(value as TabKey)}
                ariaLabel="Фильтр задач"
                icon={<Filter size={14} strokeWidth={2} />}
                className={full ? "w-full" : "w-40"}
                options={TABS.map((item) => ({ value: item.key, label: item.label }))}
              />
            ),
          },
          {
            label: "Исполнитель",
            render: (full) => (
              <Select
                value={developer}
                onChange={setDeveloper}
                ariaLabel="Исполнитель"
                className={full ? "w-full" : "w-44"}
                options={[
                  { value: "", label: "Все исполнители" },
                  ...DEVELOPERS.map((name) => ({ value: name, label: name })),
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
        {tasks === null ? (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
        ) : tasks.length === 0 ? (
          <EmptyState
            title={tab === "overdue" ? "Ничего не горит" : "Пока пусто"}
            note={
              tab === "overdue"
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
        ) : (
          <ul className="space-y-3 sm:space-y-2">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={() => void toggleDone(task)}
                onOpen={() => setEditing(task)}
              />
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <TaskModal
          title="Новая задача"
          projects={projects}
          initial={{
            ...emptyTaskValues({}),
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

function TaskRow({
  task,
  onToggle,
  onOpen,
}: {
  task: Task;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const done = task.status === "done" || task.status === "cancelled";
  const deadline = task.dueAt && !done ? describeDeadline(task.dueAt) : null;

  return (
    <li
      data-card-id={task.id}
      className="border-border bg-background hover:border-accent-border flex items-start gap-3 rounded-xl border px-3 py-3 transition hover:shadow-sm sm:py-2.5"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? "Вернуть в работу" : "Отметить выполненной"}
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition",
          done
            ? "border-success bg-success text-white"
            : "border-border hover:border-accent",
        )}
      >
        {done && <Check size={13} strokeWidth={3} />}
      </button>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block truncate text-sm font-medium",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.priority === "high" && !done && "❗ "}
          {task.title}
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {[
            task.project?.title,
            task.developers.length ? task.developers.join(", ") : "ничья",
            done ? TASK_STATUS_LABELS[task.status] : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>

      {deadline && (
        <Badge tone={deadline.tone} className="mt-0.5 max-w-56 truncate">
          {deadline.label}
        </Badge>
      )}
    </li>
  );
}

function TaskModal({
  title,
  initial,
  projects,
  current,
  taskId,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  initial: TaskFormValues;
  projects: Project[];
  current?: { id: string; title: string } | null;
  /** Есть только у сохранённой задачи — заметки вешать не на что, пока её нет. */
  taskId?: string;
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

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <TaskFields
          values={values}
          onChange={setValues}
          projects={projects}
          current={current}
        />

        {taskId && (
          <div className="mt-4">
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

        <div className="mt-5 flex items-center gap-2">
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
      </form>
    </Modal>
  );
}
