import { Check } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { updateCredential, type Credential } from "@/api/credentials";
import type { Lead } from "@/api/leads";
import type { Project } from "@/api/projects";
import { updateTask, type Task } from "@/api/tasks";
import { getToday, type TodaySnapshot } from "@/api/today";
import { useCurrentUser } from "@/auth/auth-context";
import { Badge, EmptyState, ErrorNote } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  describeDeadline,
  formatDate,
  fromDateInputValue,
  nextRenewalDate,
  periodLabel,
  toDateInputValue,
} from "@/lib/dates";
import { fee, money } from "@/lib/money";
import { Link } from "react-router";

/**
 * Главный экран: что горит прямо сейчас. Ровно то же, что бот присылает в
 * девять утра, — бот закрывает утро, экран нужен в течение дня.
 *
 * Каждая строка ведёт не в раздел, а прямо к своей карточке: через
 * `?focus=<id>`, который экран раздела разбирает сам (`useFocusFromLink`).
 * Переход просто в раздел означал бы искать в списке то, что человек только
 * что видел перед собой.
 *
 * Именно к карточке, а не в неё: окно не открывается. «Сегодня» отвечает на
 * «что горит», и строка здесь — пункт списка, а не пункт назначения; человек
 * может просто хотеть посмотреть, где она стоит и что рядом. Открывать окно
 * за него — решать, что он собрался править. Карточка вместо этого коротко
 * подсвечивается, чтобы её не искать глазами заново.
 *
 * Порядок блоков не случаен: сверху то, что уже просрочено, снизу то, что ещё
 * можно успеть. Ничьи лиды идут выше своих задач — потерянный лид стоит дороже
 * сдвинутой задачи.
 */
export function TodayScreen() {
  const user = useCurrentUser();
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getToday()
      .then(setSnapshot)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, []);

  useEffect(load, [load]);

  async function completeTask(task: Task) {
    setSnapshot((current) =>
      current === null
        ? null
        : {
            ...current,
            tasks: {
              overdue: current.tasks.overdue.filter((item) => item.id !== task.id),
              today: current.tasks.today.filter((item) => item.id !== task.id),
            },
          },
    );
    try {
      await updateTask(task.id, { status: "done" });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      load();
    }
  }

  /**
   * Продление прямо с главного экрана. Блок «Пора продлевать» — единственное
   * место, где про истекающий домен вообще вспоминают, и уводить оттуда в
   * «Доступы» ради одной даты значит терять половину продлений по дороге.
   *
   * Отправляем только `renewsAt`: PATCH применяет пришедшие поля и не трогает
   * остальные, поэтому шифротекст пароля остаётся на месте.
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

  const greeting = user.name ? `Привет, ${user.name}` : "Сегодня";

  return (
    <section>
      <header>
        <h1 className="text-xl font-bold tracking-tight">{greeting}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          То же, что бот присылает утром. Пусто — значит всё под контролем.
        </p>
      </header>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {snapshot === null ? (
        <p className="text-muted-foreground mt-6 text-sm">Загружаем…</p>
      ) : snapshot.empty ? (
        <div className="mt-6">
          <EmptyState
            title="Ничего не горит"
            note="Ни просроченных лидов, ни задач на сегодня. Свободны."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-9 sm:space-y-7">
          <Block
            title="Лиды просрочены"
            items={snapshot.leads.overdue}
            tone="danger"
            render={(lead) => <LeadLine key={lead.id} lead={lead} showDeadline />}
          />
          <Block
            title="Лиды на сегодня"
            items={snapshot.leads.today}
            render={(lead) => <LeadLine key={lead.id} lead={lead} showDeadline />}
          />
          <Block
            title="Ничьи, срок наступил"
            items={snapshot.leads.orphanUrgent}
            tone="danger"
            note="Не в чьём-то личном списке — про них не вспомнит никто"
            render={(lead) => <LeadLine key={lead.id} lead={lead} showDeadline />}
          />
          <Block
            title="Никто не взял"
            items={snapshot.leads.unclaimed}
            tone="danger"
            note="Пришли, но исполнителя и срока нет"
            render={(lead) => <LeadLine key={lead.id} lead={lead} />}
          />
          <Block
            title="Задачи просрочены"
            items={snapshot.tasks.overdue}
            tone="danger"
            render={(task) => (
              <TaskLine
                key={task.id}
                task={task}
                showDeadline
                onComplete={() => void completeTask(task)}
              />
            )}
          />
          <Block
            title="Задачи на сегодня"
            items={snapshot.tasks.today}
            render={(task) => (
              <TaskLine
                key={task.id}
                task={task}
                onComplete={() => void completeTask(task)}
              />
            )}
          />
          <Block
            title="Проекты — подходит срок"
            items={snapshot.projects.urgent}
            render={(project) => <ProjectLine key={project.id} project={project} />}
          />
          <Block
            title="Пора продлевать"
            items={snapshot.credentials.expiring}
            note="Домены, хостинг и подписки со сроком в ближайшие две недели"
            render={(item) => (
              <CredentialLine key={item.id} item={item} onPaid={() => markPaid(item)} />
            )}
          />
          <Block
            title="Счета не выставлены"
            items={snapshot.projects.unbilled}
            tone="danger"
            note="Помесячные проекты, по которым есть пропущенный месяц"
            render={(project) => <UnbilledLine key={project.id} project={project} />}
          />
        </div>
      )}
    </section>
  );
}

function Block<T>({
  title,
  items,
  render,
  tone = "neutral",
  note,
}: {
  title: string;
  items: T[];
  render: (item: T) => ReactNode;
  tone?: "neutral" | "danger";
  note?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <h2 className={cn("text-sm font-semibold", tone === "danger" && "text-danger")}>
          {title}
        </h2>
        <span className="text-muted-foreground text-xs">{items.length}</span>
      </div>
      {note && <p className="text-muted-foreground mt-0.5 text-xs">{note}</p>}
      <ul className="divide-border mt-2 divide-y">{items.map(render)}</ul>
    </div>
  );
}

function LeadLine({ lead, showDeadline }: { lead: Lead; showDeadline?: boolean }) {
  const deadline =
    showDeadline && lead.nextActionAt ? describeDeadline(lead.nextActionAt) : null;

  return (
    <li className="flex items-start gap-3 py-3.5 sm:py-2.5">
      <Link to={`/leads?focus=${lead.id}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {lead.nextActionNote?.trim() || lead.name?.trim() || lead.contact}
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {[lead.nextActionNote?.trim() ? lead.name?.trim() || lead.contact : null]
            .filter(Boolean)
            .join(" · ") || lead.contact}
        </span>
      </Link>
      {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
    </li>
  );
}

function TaskLine({
  task,
  showDeadline,
  onComplete,
}: {
  task: Task;
  showDeadline?: boolean;
  onComplete: () => void;
}) {
  const deadline = showDeadline && task.dueAt ? describeDeadline(task.dueAt) : null;

  return (
    <li className="flex items-start gap-3 py-3.5 sm:py-2.5">
      <button
        type="button"
        onClick={onComplete}
        aria-label="Отметить выполненной"
        className="border-border hover:border-accent mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition"
      >
        <Check size={13} strokeWidth={3} className="opacity-0 hover:opacity-40" />
      </button>
      <Link to={`/tasks?focus=${task.id}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {task.priority === "high" && "❗ "}
          {task.title}
        </span>
        {task.project && (
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {task.project.title}
          </span>
        )}
      </Link>
      {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
    </li>
  );
}

/**
 * Счёт, о котором забыли, — это не срок, а недополученные деньги, поэтому
 * справа стоит сумма, а не подпись к дате. Число месяцев важнее самого раннего
 * из них: один месяц — забывчивость, четыре — потерянные деньги.
 */
function UnbilledLine({ project }: { project: Project }) {
  return (
    <li className="flex items-start gap-3 py-3.5 sm:py-2.5">
      <Link to={`/projects?focus=${project.id}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{project.title}</span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {[project.client?.name, `с ${periodLabel(project.unbilledPeriod ?? "")}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Link>
      <Badge tone="danger">{`${project.unbilledCount} мес.`}</Badge>
      {project.monthlyAmountMinor !== null && (
        <span className="text-sm font-medium">
          {money(project.monthlyAmountMinor * project.unbilledCount, project.currency)}
        </span>
      )}
    </li>
  );
}

/**
 * Продление показывается как обычный срок: истёкший домен так же ломает работу,
 * как просроченная задача, и выделять его отдельным видом строки незачем.
 */
function CredentialLine({
  item,
  onPaid,
}: {
  item: Credential;
  onPaid: () => Promise<void>;
}) {
  const deadline = item.renewsAt ? describeDeadline(item.renewsAt) : null;
  const [saving, setSaving] = useState(false);
  const paidUntil = nextRenewalDate(toDateInputValue(item.renewsAt));

  return (
    <li className="flex flex-col gap-2 py-3.5 sm:py-2.5">
      <div className="flex items-start gap-3">
        <Link to={`/credentials?focus=${item.id}`} className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.service}</span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {[item.login, item.owner ?? "ни на кого не оформлен"]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </Link>
        {item.amountMinor != null && (
          <span className="shrink-0 text-sm font-medium">
            {fee(item.amountMinor, item.monthlyFee, item.currency)}
          </span>
        )}
        {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onPaid().finally(() => setSaving(false));
          }}
          className="text-muted-foreground hover:bg-accent-soft hover:text-foreground inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition disabled:opacity-50"
        >
          <Check size={13} strokeWidth={2.5} />
          {saving
            ? "Продлеваем…"
            : `Оплатил до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
        </button>
      </div>
    </li>
  );
}

function ProjectLine({ project }: { project: Project }) {
  const deadline = project.deadline ? describeDeadline(project.deadline) : null;

  return (
    <li className="flex items-start gap-3 py-3.5 sm:py-2.5">
      <Link to={`/projects?focus=${project.id}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{project.title}</span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {[
            project.client?.name,
            project.developers.length ? project.developers.join(", ") : "никто не ведёт",
            project.openTaskCount > 0 ? `открытых задач ${project.openTaskCount}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </Link>
      {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
    </li>
  );
}
