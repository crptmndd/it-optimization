import type { Project } from "@/api/projects";
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "@/api/tasks";
import { DeveloperPicker } from "@/components/developer-picker";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";

export interface TaskFormValues {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  developers: string[];
  dueDate: string;
}

export function emptyTaskValues(defaults: { projectId?: string }): TaskFormValues {
  return {
    title: "",
    description: "",
    status: "todo",
    priority: "normal",
    projectId: defaults.projectId ?? "",
    developers: [],
    dueDate: "",
  };
}

export function taskToValues(task: Task): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    projectId: task.project?.id ?? "",
    developers: task.developers,
    dueDate: toDateInputValue(task.dueAt),
  };
}

export function valuesToTaskInput(values: TaskFormValues): TaskInput {
  return {
    title: values.title.trim(),
    description: values.description.trim() || null,
    status: values.status,
    priority: values.priority,
    projectId: values.projectId || null,
    developers: values.developers,
    dueAt: fromDateInputValue(values.dueDate),
  };
}

export function TaskFields({
  values,
  onChange,
  projects,
  current,
}: {
  values: TaskFormValues;
  onChange: (values: TaskFormValues) => void;
  projects: Project[];
  /**
   * Проект самой задачи. В выборе только открытые, а задача может стоять на закрытом
   * или архивном: без него поле показало бы прочерк, будто привязка потеряна.
   */
  current?: { id: string; title: string } | null;
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
          autoFocus
          maxLength={300}
          placeholder="Сверстать главную · выставить счёт · продлить домен"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Статус">
          <Select
            value={values.status}
            onChange={(next) => set("status", next as TaskStatus)}
            options={TASK_STATUSES.map((item) => ({
              value: item,
              label: TASK_STATUS_LABELS[item],
            }))}
          />
        </Field>

        <Field label="Важность">
          <Select
            value={values.priority}
            onChange={(next) => set("priority", next as TaskPriority)}
            options={TASK_PRIORITIES.map((item) => ({
              value: item,
              label: TASK_PRIORITY_LABELS[item],
            }))}
          />
        </Field>
      </div>

      <DeveloperPicker
        value={values.developers}
        onChange={(next) => set("developers", next)}
        label="Кто делает"
        hint="Имя попадёт в утреннюю сводку в общий чат"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Срок" hint="Пусто — напоминания не будет">
          <Input
            type="date"
            value={values.dueDate}
            onChange={(event) => set("dueDate", event.target.value)}
          />
        </Field>
      </div>

      <Field label="Проект" hint="Не всякая задача относится к проекту — это нормально">
        <Select
          value={values.projectId}
          onChange={(projectId) => set("projectId", projectId)}
          options={[
            { value: "", label: "Без проекта" },
            ...options.map((project) => ({ value: project.id, label: project.title })),
          ]}
        />
      </Field>

      <Field label="Подробности">
        <Textarea
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          rows={3}
        />
      </Field>
    </div>
  );
}
