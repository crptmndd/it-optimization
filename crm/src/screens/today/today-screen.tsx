import { Check, Flame } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import { updateCredential, type Credential } from "@/api/credentials";
import type { Bill, Project } from "@/api/projects";
import { updateTask, type Task } from "@/api/tasks";
import { getToday, type TodaySnapshot } from "@/api/today";
import { useCurrentUser } from "@/auth/auth-context";
import { PeopleFilter } from "@/components/people-filter";
import { PersonChips } from "@/components/person-chip";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  PageHeader,
  SectionTitle,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  describeDeadline,
  formatDate,
  fromDateInputValue,
  nextRenewalDate,
  periodLabel,
  toDateInputValue,
} from "@/lib/dates";
import { fee, formatTotals, money, sumByCurrency } from "@/lib/money";
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
 * подсвечивается, чтобы её не искать глазами заново. Исключение — деньги: счёт
 * живёт внутри карточки проекта, и подвести можно только к ней самой.
 *
 * Порядок блоков не случаен: сверху работа, которая уже просрочена, снизу то,
 * что ещё можно успеть, и отдельно деньги — у них другой вопрос: не «что
 * делать», а «кто кому должен».
 */

/**
 * Адреса блоков для плиток сверху. Одним списком: плитка без своего блока молча
 * никуда бы не прокручивала.
 */
const BLOCK = {
  overdue: "today-overdue",
  today: "today-tasks",
  unassigned: "today-unassigned",
  urgent: "today-projects-urgent",
  soon: "today-projects-soon",
  renewals: "today-renewals",
  unbilled: "today-unbilled",
  unpaid: "today-unpaid",
  nextStages: "today-next-stages",
} as const;

const TITLE = "block truncate text-[15px] font-semibold";
const SECONDARY = "text-muted-foreground block truncate text-[13px] font-medium";
const AMOUNT = "text-[15px] font-semibold whitespace-nowrap tabular-nums";

/*
 * Те же колонки, что у строки задачи в разделе «Задачи», чтобы название, проект и
 * срок стояли на привычных местах. Колонки включаются с xl, а не с sm: с 768px
 * появляется боковое меню, и до 1280px фиксированные колонки съедают название.
 * Две строки на узком экране показывают то же самое и не обрезают его.
 */
const WORK_ROW =
  "grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 pr-4 xl:grid-cols-[minmax(0,1fr)_12rem_3.5rem_9.75rem]";

/** На телефоне сумма стоит в правом верхнем углу строки, вторичное уходит вниз. */
const MONEY_ROW =
  "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5";

const dayInWords = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** «Понедельник, 2 ноября». */
function todayInWords(): string {
  const text = dayInWords.format(new Date());
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function TodayScreen() {
  const user = useCurrentUser();
  /** Пустая строка — вся команда, так считает `PeopleFilter`. В запрос она не уходит. */
  const [person, setPerson] = useState("");
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Ответ по прошлому человеку не должен лечь поверх уже выбранного. */
  const request = useRef(0);

  const load = useCallback(() => {
    setError(null);
    const current = (request.current += 1);
    getToday(person || undefined)
      .then((result) => {
        if (current === request.current) setSnapshot(result);
      })
      .catch((cause: unknown) => {
        if (current !== request.current) return;
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      });
  }, [person]);

  useEffect(load, [load]);

  async function completeTask(task: Task) {
    const without = (items: Task[]) => items.filter((item) => item.id !== task.id);
    setSnapshot((current) =>
      current === null
        ? null
        : {
            ...current,
            tasks: {
              overdue: without(current.tasks.overdue),
              today: without(current.tasks.today),
              unassigned: without(current.tasks.unassigned),
            },
          },
    );
    try {
      await updateTask(task.id, { status: "done" });
      // Последняя закрытая задача должна привести к пустому состоянию, а его
      // считает сервер.
      load();
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
   * остальные, поэтому пароль остаётся на месте.
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
  const hasMoney =
    snapshot !== null &&
    snapshot.projects.unbilled.length +
      snapshot.money.unpaid.length +
      snapshot.money.nextStages.length >
      0;

  return (
    <section>
      <PageHeader title={greeting} subtitle={todayInWords()}>
        <PeopleFilter value={person} onChange={setPerson} />
      </PageHeader>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {snapshot === null ? (
        <div className="mt-5">
          <LoadingRows />
        </div>
      ) : snapshot.empty ? (
        <div className="mt-5">
          <EmptyState
            title="Ничего не горит"
            note="Ни просроченных задач, ни денег, которые ждут. Свободны."
          />
        </div>
      ) : (
        <>
          <Tiles snapshot={snapshot} />

          <div className="mt-6 space-y-6">
            <Block
              id={BLOCK.overdue}
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
              id={BLOCK.today}
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
              id={BLOCK.unassigned}
              title="Без исполнителя"
              items={snapshot.tasks.unassigned}
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
              id={BLOCK.urgent}
              title="Проекты — подходит срок"
              items={snapshot.projects.urgent}
              render={(project) => <ProjectLine key={project.id} project={project} />}
            />
            <Block
              id={BLOCK.soon}
              title="Проекты — скоро срок"
              items={snapshot.projects.soon}
              render={(project) => <ProjectLine key={project.id} project={project} />}
            />
            <Block
              id={BLOCK.renewals}
              title="Пора продлевать"
              items={snapshot.credentials.expiring}
              render={(item) => (
                <CredentialLine key={item.id} item={item} onPaid={() => markPaid(item)} />
              )}
            />

            {hasMoney && (
              <div className="pt-2">
                <h2 className="mb-4 px-1 text-xl font-extrabold tracking-tight">
                  Деньги
                </h2>
                <div className="space-y-6">
                  <Block
                    id={BLOCK.unbilled}
                    title="Не выставлено"
                    items={snapshot.projects.unbilled}
                    tone="danger"
                    render={(project) => (
                      <UnbilledLine key={project.id} project={project} />
                    )}
                  />
                  <Block
                    id={BLOCK.unpaid}
                    title="Не оплачено"
                    items={snapshot.money.unpaid}
                    total={formatTotals(sumByCurrency(snapshot.money.unpaid))}
                    render={(bill) => <BillLine key={bill.id} bill={bill} />}
                  />
                  <Block
                    id={BLOCK.nextStages}
                    title="Следующий этап"
                    items={snapshot.money.nextStages}
                    total={formatTotals(sumByCurrency(snapshot.money.nextStages))}
                    render={(bill) => <BillLine key={bill.id} bill={bill} />}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Сводка над списком и заодно его оглавление: экран длинный, а на телефоне деньги
 * лежат на несколько экранов ниже первой задачи. Без красного на нуле: красный здесь
 * значит «есть что разбирать», а не название плитки.
 */
function Tiles({ snapshot }: { snapshot: TodaySnapshot }) {
  const { tasks, projects, credentials, money: bills } = snapshot;

  return (
    <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-2.5 xl:grid-cols-6">
      <Tile
        label="Просрочено"
        count={tasks.overdue.length}
        target={BLOCK.overdue}
        danger
      />
      <Tile label="На сегодня" count={tasks.today.length} target={BLOCK.today} />
      <Tile
        label="Сроки проектов"
        count={projects.urgent.length + projects.soon.length}
        target={projects.urgent.length > 0 ? BLOCK.urgent : BLOCK.soon}
      />
      <Tile
        label="Продлить"
        count={credentials.expiring.length}
        target={BLOCK.renewals}
      />
      <Tile
        label="Не выставлено"
        count={projects.unbilled.length}
        target={BLOCK.unbilled}
        danger
      />
      <Tile
        label="К оплате"
        count={bills.unpaid.length + bills.nextStages.length}
        target={bills.unpaid.length > 0 ? BLOCK.unpaid : BLOCK.nextStages}
      />
    </div>
  );
}

function Tile({
  label,
  count,
  target,
  danger,
}: {
  label: string;
  count: number;
  target: string;
  danger?: boolean;
}) {
  function scrollToBlock() {
    // Движение по `<main>` длиной в несколько экранов: просившим интерфейс не
    // двигаться показываем сразу нужное место.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(target)
      ?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  }

  return (
    <Card>
      {/* На нуле блока нет вовсе, прокручивать не к чему. */}
      <button
        type="button"
        disabled={count === 0}
        onClick={scrollToBlock}
        className="enabled:hover:bg-muted/60 h-full w-full rounded-2xl px-3 py-2.5 text-left transition-colors sm:px-4 sm:py-3"
      >
        <span
          className={cn(
            "block text-2xl leading-8 font-extrabold tracking-tight tabular-nums sm:text-[28px]",
            count === 0 ? "text-muted-foreground" : danger && "text-danger",
          )}
        >
          {count}
        </span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-tight font-medium sm:text-[13px]">
          {label}
        </span>
      </button>
    </Card>
  );
}

function Block<T>({
  id,
  title,
  items,
  render,
  tone,
  total,
}: {
  id: string;
  title: string;
  items: T[];
  render: (item: T) => ReactNode;
  tone?: "danger";
  /** Итог по каждой валюте отдельно: курса у CRM нет. Пустых сумм в нём нет вовсе. */
  total?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div id={id} className="scroll-mt-3">
      <SectionTitle title={title} count={items.length} tone={tone}>
        {total && (
          /* Занимает остаток ряда и переносится сам: иначе две валюты на телефоне
             выдавливают на вторую строку заголовок. */
          <span className={cn(AMOUNT, "min-w-0 flex-1 text-right whitespace-normal")}>
            <span className="text-muted-foreground font-medium">Всего </span>
            {total}
          </span>
        )}
      </SectionTitle>
      <List>{items.map(render)}</List>
    </div>
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
    <li className="hover:bg-muted/60 flex items-stretch transition-colors">
      <button
        type="button"
        onClick={onComplete}
        aria-label="Отметить выполненной"
        className="group flex w-12 shrink-0 items-center justify-center pl-1"
      >
        <span className="ring-foreground/20 group-hover:ring-foreground/50 group-hover:text-muted-foreground flex size-[22px] items-center justify-center rounded-full text-transparent ring-2 transition ring-inset">
          <Check size={14} strokeWidth={3} />
        </span>
      </button>

      <Link to={`/tasks?focus=${task.id}`} className={cn(WORK_ROW, "flex-1")}>
        <span className="flex min-w-0 items-center gap-2">
          {task.priority === "high" && (
            <Flame
              size={15}
              strokeWidth={2.5}
              aria-label="Срочно"
              className="text-danger shrink-0"
            />
          )}
          <span className="truncate text-[15px] font-semibold">{task.title}</span>
        </span>

        <span className={cn(SECONDARY, "hidden xl:block")}>{task.project?.title}</span>

        <span className="row-span-2 flex justify-end xl:row-span-1">
          {task.developers.length > 0 ? (
            <PersonChips names={task.developers} />
          ) : (
            <span className="text-muted-foreground text-xs">ничья</span>
          )}
        </span>

        <span className="col-start-1 mt-0.5 flex min-w-0 items-center gap-2 empty:hidden xl:col-start-auto xl:mt-0 xl:justify-end">
          {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
          {task.project && (
            <span className={cn(SECONDARY, "xl:hidden")}>{task.project.title}</span>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * Счёт, о котором забыли, — это не срок, а недополученные деньги, поэтому
 * справа стоит сумма, а не подпись к дате. Число месяцев важнее самого раннего
 * из них: один месяц — забывчивость, четыре — потерянные деньги.
 */
function UnbilledLine({ project }: { project: Project }) {
  const first = periodLabel(project.unbilledPeriod ?? "");

  return (
    <li className="hover:bg-muted/60 transition-colors">
      <Link
        to={`/projects?focus=${project.id}`}
        className={cn(MONEY_ROW, "xl:grid-cols-[minmax(0,1fr)_13rem_4.5rem_8rem]")}
      >
        <span className="min-w-0">
          <span className={TITLE}>{project.title}</span>
          <span className={SECONDARY}>{project.client?.name}</span>
        </span>
        <span className={cn(SECONDARY, "max-xl:col-start-1 max-xl:row-start-2")}>
          {project.unbilledCount > 1 ? `первый пропуск: ${first}` : `за ${first}`}
        </span>
        <Badge
          tone="danger"
          className="justify-self-end max-xl:col-start-2 max-xl:row-start-2"
        >{`${project.unbilledCount} мес.`}</Badge>
        <span
          className={cn(
            AMOUNT,
            "text-right max-xl:col-start-2 max-xl:row-start-1 max-xl:self-start",
          )}
        >
          {project.monthlyAmountMinor !== null &&
            money(project.monthlyAmountMinor * project.unbilledCount, project.currency)}
        </span>
      </Link>
    </li>
  );
}

/**
 * Счёт либо этап договора. Ведёт в карточку проекта, а не к ней: оплата и сумма
 * правятся там, и показать «где она стоит» здесь нечего. Сумма справа, как у
 * невыставленных: это не срок, а деньги.
 */
function BillLine({ bill }: { bill: Bill }) {
  const what = bill.stage
    ? `Этап ${bill.stage.position} из ${bill.stage.total}`
    : bill.period && periodLabel(bill.period);

  return (
    <li className="hover:bg-muted/60 transition-colors">
      <Link
        to={`/projects?open=${bill.project.id}`}
        className={cn(MONEY_ROW, "xl:grid-cols-[minmax(0,1fr)_8rem_9.5rem_8rem]")}
      >
        <span className="min-w-0">
          <span className={TITLE}>{bill.project.title}</span>
          <span className={SECONDARY}>{bill.project.client}</span>
        </span>
        <span className={cn(SECONDARY, "max-xl:col-start-1 max-xl:row-start-2")}>
          {what}
        </span>
        <span
          className={cn(SECONDARY, "text-right max-xl:col-start-2 max-xl:row-start-2")}
        >
          {bill.issuedAt && `выставлен ${formatDate(bill.issuedAt)}`}
        </span>
        {/* Здесь, как и в «Счетах», отсутствие суммы — подпись, а не сигнал. */}
        <span className="text-right max-xl:col-start-2 max-xl:row-start-1 max-xl:self-start">
          {bill.amountMinor === null ? (
            <span className="text-muted-foreground text-[13px] font-medium">
              сумма не указана
            </span>
          ) : (
            <span className={AMOUNT}>{money(bill.amountMinor, bill.currency)}</span>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * Продление показывается как обычный срок: истёкший домен так же ломает работу,
 * как просроченная задача, и выделять его отдельным видом строки незачем.
 *
 * Вся строка ведёт к карточке, но кнопка стоит рядом с содержимым, а не внутри
 * ссылки: кнопка в ссылке — недопустимая разметка. Поэтому ссылка лежит слоем поверх
 * строки, а кнопка поднята над ней.
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
    <li className="hover:bg-muted/60 relative grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 transition-colors xl:grid-cols-[minmax(0,1fr)_10rem_7rem_9.75rem_minmax(11rem,auto)]">
      <Link
        to={`/credentials?focus=${item.id}`}
        aria-label={item.service}
        className="absolute inset-0 focus-visible:-outline-offset-2"
      />

      <span className="min-w-0">
        <span className={TITLE}>{item.service}</span>
        <span className={SECONDARY}>{item.login}</span>
      </span>

      <span className={cn(SECONDARY, "max-xl:col-start-1 max-xl:row-start-2")}>
        {item.owner ?? "ни на кого не оформлен"}
      </span>

      <span
        className={cn(
          AMOUNT,
          "text-right max-xl:col-start-2 max-xl:row-start-1 max-xl:self-start",
        )}
      >
        {item.amountMinor != null &&
          fee(item.amountMinor, item.monthlyFee, item.currency)}
      </span>

      {/* Общая обёртка на узком экране: кнопка с длинной датой переносится под срок,
          а не наезжает на него. С xl обёртки нет, это две обычные колонки. */}
      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 max-xl:col-span-2 max-xl:row-start-3 xl:contents">
        <span className="flex xl:justify-end">
          {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
        </span>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            void onPaid().finally(() => setSaving(false));
          }}
          className="relative ml-auto xl:ml-0 xl:w-full"
        >
          <Check size={15} strokeWidth={2.25} />
          {saving
            ? "Продлеваем…"
            : `Оплатил до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
        </Button>
      </span>
    </li>
  );
}

function ProjectLine({ project }: { project: Project }) {
  const deadline = project.deadline ? describeDeadline(project.deadline) : null;
  const openTasks = project.openTaskCount > 0 ? project.openTaskCount : null;

  return (
    <li className="hover:bg-muted/60 transition-colors">
      <Link to={`/projects?focus=${project.id}`} className={cn(WORK_ROW, "pl-4")}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{project.title}</span>
          {openTasks && (
            <Badge className="hidden xl:inline-flex">открытых задач {openTasks}</Badge>
          )}
        </span>

        <span className={cn(SECONDARY, "hidden xl:block")}>{project.client?.name}</span>

        <span className="row-span-2 flex justify-end xl:row-span-1">
          {project.developers.length > 0 ? (
            <PersonChips names={project.developers} />
          ) : (
            <span title="Никто не ведёт" className="text-muted-foreground text-xs">
              никто
            </span>
          )}
        </span>

        <span className="col-start-1 mt-0.5 flex min-w-0 items-center gap-2 empty:hidden xl:col-start-auto xl:mt-0 xl:justify-end">
          {deadline && <Badge tone={deadline.tone}>{deadline.label}</Badge>}
          {project.client && (
            <span className={cn(SECONDARY, "xl:hidden")}>{project.client.name}</span>
          )}
          {openTasks && (
            <span className={cn(SECONDARY, "shrink-0 xl:hidden")}>задач {openTasks}</span>
          )}
        </span>
      </Link>
    </li>
  );
}
