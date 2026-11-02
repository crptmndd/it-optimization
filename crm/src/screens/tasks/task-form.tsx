import { Flame } from "lucide-react";
import { Link } from "react-router";
import type { Project } from "@/api/projects";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/api/tasks";
import { isAdmin, useCurrentUser } from "@/auth/auth-context";
import { DateField } from "@/components/date-field";
import { DeveloperPicker } from "@/components/developer-picker";
import { Field, Input, Select, Switch } from "@/components/ui";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { usePeople } from "@/lib/people";

export interface TaskFormValues {
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  developers: string[];
  dueDate: string;
}

export function emptyTaskValues(defaults: {
  projectId?: string;
  developers?: string[];
}): TaskFormValues {
  return {
    title: "",
    status: "todo",
    priority: "normal",
    projectId: defaults.projectId ?? "",
    developers: defaults.developers ?? [],
    dueDate: "",
  };
}

export function taskToValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.project?.id ?? "",
    developers: task.developers,
    dueDate: toDateInputValue(task.dueAt),
  };
}

/**
 * Описания в запросе нет вовсе: поля больше нет в форме, и `null` здесь стёр бы старое
 * значение, которое на время выката ещё нужно откату.
 */
export function valuesToTaskInput(values: TaskFormValues): TaskInput {
  return {
    title: values.title.trim(),
    status: values.status,
    priority: values.priority,
    projectId: values.projectId || null,
    developers: values.developers,
    dueAt: fromDateInputValue(values.dueDate),
  };
}

/**
 * Предупреждает сразу, а не когда в чате не сработал тэг. Ник вписывают один раз,
 * и лучшее место напомнить о нём — момент, когда он понадобился.
 */
function MissingHandleHint({ people }: { people: string[] }) {
  const team = usePeople();
  const admin = isAdmin(useCurrentUser());
  if (!team) return null;

  // Админу бот пишет лично, ник в чате ему не нужен.
  const missing = people.filter((name) => {
    const person = team.find((item) => item.name === name);
    return person?.role !== "admin" && !person?.telegramUsername;
  });
  if (missing.length === 0) return null;

  return (
    <p className="text-warning text-xs font-medium">
      {missing.join(", ")}: ник в Telegram не указан, бот может не отметить.{" "}
      {admin && (
        // В новой вкладке: ссылка стоит внутри окна, и уход закрыл бы несохранённую форму.
        <Link
          to="/settings?focus=team"
          target="_blank"
          className="font-bold underline underline-offset-2"
        >
          Указать
        </Link>
      )}
    </p>
  );
}

export function TaskFields({
  values,
  onChange,
  projects,
  current,
  editing = false,
}: {
  values: TaskFormValues;
  onChange: (values: TaskFormValues) => void;
  projects: Project[];
  /**
   * Проект самой задачи. В выборе только открытые, а задача может стоять на закрытом
   * или архивном: без него поле показало бы прочерк, будто привязка потеряна.
   */
  current?: { id: string; title: string } | null;
  /**
   * Статус есть только у заведённой задачи. Новая всегда встаёт «К работе»: выбирать
   * тут нечего, а лишнее поле замедляет то, что делают по десять раз на дню.
   */
  editing?: boolean;
}) {
  function set<K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  const options =
    current && !projects.some((project) => project.id === current.id)
      ? [...projects, current]
      : projects;

  return (
    <div className="space-y-4">
      <Field label="Что сделать">
        <Input
          value={values.title}
          onChange={(event) => set("title", event.target.value)}
          required
          autoFocus={!editing}
          maxLength={300}
          placeholder="Например, продлить домен"
          className="h-12 text-base font-semibold"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <DeveloperPicker
          value={values.developers}
          onChange={(next) => set("developers", next)}
          label="Кто делает"
          placeholder="Выбрать"
        />

        <Field label="Срок">
          <DateField
            value={values.dueDate}
            onChange={(next) => set("dueDate", next)}
            placeholder="Без срока"
            clearLabel="Убрать срок"
            ariaLabel="Срок"
            quick
          />
        </Field>

        <Field label="Проект">
          <Select
            value={values.projectId}
            onChange={(projectId) => set("projectId", projectId)}
            ariaLabel="Проект"
            options={[
              { value: "", label: "Без проекта" },
              ...options.map((project) => ({ value: project.id, label: project.title })),
            ]}
          />
        </Field>

        {editing ? (
          <Field label="Статус">
            <Select
              value={values.status}
              onChange={(next) => set("status", next as TaskStatus)}
              ariaLabel="Статус"
              options={TASK_STATUSES.map((item) => ({
                value: item,
                label: TASK_STATUS_LABELS[item],
              }))}
            />
          </Field>
        ) : (
          <UrgentSwitch values={values} onChange={onChange} withLabel />
        )}
      </div>

      {editing && <UrgentSwitch values={values} onChange={onChange} />}

      {/* На всю ширину и под полями: в колонке текст переносился и сдвигал поле рядом
          прямо под открытым списком исполнителей. */}
      <MissingHandleHint people={values.developers} />
    </div>
  );
}

/**
 * Важность — один переключатель. Три степени никто не различал: задача либо срочная,
 * либо обычная. Старая «низкая» при открытии не меняется, пока переключатель не тронут.
 */
function UrgentSwitch({
  values,
  onChange,
  withLabel = false,
}: {
  values: TaskFormValues;
  onChange: (values: TaskFormValues) => void;
  /** В ряду с полями нужна подпись сверху, иначе переключатель съезжает вверх. */
  withLabel?: boolean;
}) {
  const control = (
    <Switch
      checked={values.priority === "high"}
      onChange={(on) => onChange({ ...values, priority: on ? "high" : "normal" })}
      label="Срочно"
      icon={Flame}
    />
  );
  if (!withLabel) return control;

  return (
    <div>
      <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
        Важность
      </span>
      {control}
    </div>
  );
}
