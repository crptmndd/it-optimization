import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import { columnOf, useColumns } from "@/api/columns";
import {
  addProjectNote,
  CLOSED_PROJECT_STATUSES,
  getProject,
  type Project,
} from "@/api/projects";
import {
  CLOSED_TASK_STATUSES,
  listTasks,
  TASK_STATUS_LABELS,
  type Task,
} from "@/api/tasks";
import { NotesPanel } from "@/components/notes-panel";
import { PersonChips } from "@/components/person-chip";
import { Badge, ErrorNote, LoadingRows, Modal } from "@/components/ui";
import { cn } from "@/lib/cn";
import { describeDeadline, formatDate } from "@/lib/dates";

/**
 * Карточка проекта у сотрудника: просмотр вместо формы.
 *
 * Отдельный компонент, а не форма с выключенными полями: запись закрыта на сервере, и
 * форма здесь только обещала бы то, что не сработает. К тому же форма и блоки оплаты
 * читают поля, которых в ответе для сотрудника нет.
 */

/**
 * Только то, что сервер отдаёт сотруднику. Узкий тип вместо `Project`: обращение к сумме
 * или оплате здесь не соберётся, а на деле упало бы, этих полей в ответе нет.
 */
export type VisibleProject = Pick<
  Project,
  | "id"
  | "title"
  | "description"
  | "status"
  | "client"
  | "developers"
  | "deadline"
  | "archivedAt"
>;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-[13px] font-medium">{label}</dt>
      <dd className="mt-1 flex min-h-6 items-center gap-2 text-[15px] font-semibold">
        {children}
      </dd>
    </div>
  );
}

function Deadline({ project }: { project: VisibleProject }) {
  if (!project.deadline) {
    return <span className="text-muted-foreground font-medium">без срока</span>;
  }
  // У сданного и убранного срок уже никого не торопит: дата, без красной плашки.
  const finished =
    project.archivedAt !== null || CLOSED_PROJECT_STATUSES.includes(project.status);
  if (finished) return <>{formatDate(project.deadline)}</>;

  const deadline = describeDeadline(project.deadline);
  return <Badge tone={deadline.tone}>{deadline.label}</Badge>;
}

const TASK_TONE: Partial<Record<Task["status"], "accent" | "success">> = {
  in_progress: "accent",
  done: "success",
};

/** Сервер отдаёт сотруднику только его задачи, поэтому своего условия здесь нет. */
function MyTasks({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const columns = useColumns("task");

  useEffect(() => {
    let alive = true;
    listTasks({ projectId, scope: "all" })
      .then((next) => {
        if (alive) setTasks(next);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  return (
    <div>
      <h3 className="text-[15px] font-bold tracking-tight">Мои задачи</h3>

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {tasks === null ? (
        <div className="mt-2">
          <LoadingRows rows={2} />
        </div>
      ) : tasks.length === 0 ? (
        !error && (
          <p className="text-muted-foreground mt-1 text-sm">
            Ваших задач здесь пока нет.
          </p>
        )
      ) : (
        <ul className="divide-border mt-1 divide-y">
          {tasks.map((task) => {
            const closed = CLOSED_TASK_STATUSES.includes(task.status);
            const deadline = task.dueAt && !closed ? describeDeadline(task.dueAt) : null;
            return (
              <li key={task.id}>
                {/* Открывает саму задачу: править её сотрудник может, в отличие от проекта. */}
                <Link
                  to={`/tasks?open=${task.id}`}
                  className="hover:bg-muted/60 -mx-2 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-2 py-2 transition-colors"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[15px] font-semibold max-sm:basis-full",
                      closed && "text-muted-foreground",
                    )}
                  >
                    {task.title}
                  </span>
                  {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
                  <Badge tone={TASK_TONE[task.status] ?? "neutral"}>
                    {/* Название колонки, которое дал админ: так же, как на доске. */}
                    {(columns && columnOf(columns, task)?.title) ??
                      TASK_STATUS_LABELS[task.status]}
                  </Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ProjectView({
  project,
  badge,
  onClose,
}: {
  project: VisibleProject;
  /** Статус и архив рядом с названием: их оформление живёт в списке проектов. */
  badge: ReactNode;
  onClose: () => void;
}) {
  const { id } = project;
  const loadNotes = useCallback(async () => (await getProject(id)).notes, [id]);
  const addNote = useCallback((body: string) => addProjectNote(id, body), [id]);

  return (
    <Modal title={project.title} badge={badge} onClose={onClose} wide>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Fact label="Клиент">
          <span className="truncate">{project.client?.name ?? "без клиента"}</span>
        </Fact>
        <Fact label="Срок">
          <Deadline project={project} />
        </Fact>
        <Fact label="Кто ведёт">
          {project.developers.length > 0 ? (
            <>
              <PersonChips names={project.developers} />
              <span className="truncate">{project.developers.join(", ")}</span>
            </>
          ) : (
            <span className="text-muted-foreground font-medium">никто</span>
          )}
        </Fact>
      </dl>

      {project.description && (
        <div className="mt-6">
          <h3 className="text-[15px] font-bold tracking-tight">О чём проект</h3>
          <p className="mt-1 text-sm break-words whitespace-pre-wrap">
            {project.description}
          </p>
        </div>
      )}

      <div className="mt-6">
        <MyTasks projectId={id} />
      </div>

      <div className="mt-6">
        <NotesPanel
          load={loadNotes}
          add={addNote}
          hint="Пока пусто. Сюда — договорённости с клиентом и решения по проекту."
        />
      </div>
    </Modal>
  );
}
