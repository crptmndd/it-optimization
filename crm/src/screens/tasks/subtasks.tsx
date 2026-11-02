import { Check, Trash2 } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ApiError } from "@/api/client";
import {
  createTask,
  deleteTask,
  updateTask,
  type Subtask,
  type SubtaskProgress,
  type TaskInput,
} from "@/api/tasks";
import { DeveloperPicker } from "@/components/developer-picker";
import { ErrorNote, Input } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Подзадачи в окне задачи. Всё сохраняется сразу, по одному действию, а не кнопкой окна:
 * галочка отзывается мгновенно и не зависит от того, что ещё открыто в форме.
 *
 * Два вида с одной разметкой: `SubtasksPanel` у сохранённой задачи и `SubtasksDraft` в
 * новой, где вешать подзадачи пока не на что и есть только названия.
 */

/** Что правится в строке. Срок и проект у подзадачи свои не задаются. */
type SubtaskChange = Pick<TaskInput, "title" | "status" | "developers">;

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

function progressOf(list: Subtask[]): SubtaskProgress {
  return {
    total: list.length,
    done: list.filter((item) => item.status === "done").length,
  };
}

function Block({
  count,
  children,
}: {
  /** Подпись рядом с заголовком. */
  count?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-bold tracking-tight">Подзадачи</h3>
        {count && (
          <span className="text-muted-foreground text-[13px] font-semibold tabular-nums">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Название правится на месте. Enter только уводит из поля, а сохраняет уход: так путь один,
 * и Enter с последующим уходом не дают двух запросов. ⌘Enter идёт дальше, к форме: окно
 * закроется без `blur`, поэтому поле отпускаем и тогда.
 */
function TitleField({
  title,
  label,
  done = false,
  onCommit,
}: {
  title: string;
  label: string;
  done?: boolean;
  onCommit: (title: string) => void;
}) {
  const [text, setText] = useState(title);

  // Другой текст приходит после отката: сервер не принял новое название.
  useEffect(() => setText(title), [title]);

  function commit() {
    const next = text.trim();
    if (next && next !== title) onCommit(next);
    // Пустое название не сохраняем: подзадачу убирает значок, а не очистка поля.
    else setText(title);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape" && text !== title) {
      // Отменяет правку, а не закрывает окно. Нечего отменять — закрывает как обычно.
      event.stopPropagation();
      setText(title);
    }
  }

  return (
    <input
      value={text}
      aria-label={label}
      title={text}
      maxLength={300}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      className={cn(
        "hover:bg-muted focus:bg-field focus:ring-accent h-8 min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 text-sm font-medium transition outline-none focus:ring-2",
        done && "text-muted-foreground line-through",
      )}
    />
  );
}

/** Значок на наведении, а где наведения нет, на телефоне, виден всегда. */
function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Удалить"
      onClick={onClick}
      className="text-muted-foreground hover:bg-danger-soft hover:text-danger flex size-7 shrink-0 items-center justify-center rounded-lg transition group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
    >
      <Trash2 size={15} strokeWidth={2.25} />
    </button>
  );
}

/** Поле внизу блока. Фокус остаётся в нём: подзадачи заводят пачкой, подряд. */
function AddField({
  value,
  onChange,
  onAdd,
  count,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onAdd: (title: string) => void;
  /** Сколько строк над полем: вырастая, список выталкивает его за край окна. */
  count: number;
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) return;
    box.current.scrollIntoView({ block: "nearest" });
  }, [count]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // С ⌘ это уже отправка всей формы, её ловит окно.
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const title = value.trim();
    if (title) onAdd(title);
  }

  return (
    <div ref={box} className="mt-2">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        maxLength={300}
        placeholder="Добавить подзадачу"
        aria-label="Добавить подзадачу"
      />
    </div>
  );
}

export interface SubtasksHandle {
  /**
   * Сохранить то, что вписано в поле, но не подтверждено Enter. Вызывается перед
   * сохранением окна: человек видит текст и считает, что он никуда не денется. `false` —
   * не вышло, ошибка уже на экране.
   */
  flush: () => Promise<boolean>;
}

/**
 * `load` — обещание, а не функция: список приходит тем же запросом, что и заметки, и окно
 * делит один ответ на два блока.
 */
export function SubtasksPanel({
  ref,
  taskId,
  load,
  onProgress,
}: {
  ref?: Ref<SubtasksHandle>;
  taskId: string;
  load: Promise<Subtask[]>;
  /** Карточка за окном показывает «2/5», и ждать закрытия окна ей незачем. */
  onProgress: (taskId: string, progress: SubtaskProgress) => void;
}) {
  const [list, setList] = useState<Subtask[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /*
   * Создание идёт строго по очереди: порядок строк — это порядок создания на сервере, а
   * при быстром Enter параллельные запросы могли бы прийти в другом порядке.
   */
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  /** Правки в пути. Окно закрывается без них, и сбой писать было бы уже некуда. */
  const saves = useRef(new Set<Promise<boolean>>());

  useEffect(() => {
    let alive = true;
    load.then((items) => alive && setList(items)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    if (list) onProgress(taskId, progressOf(list));
  }, [list, taskId, onProgress]);

  function patch(id: string, change: SubtaskChange) {
    setList(
      (current) =>
        current?.map((item) => (item.id === id ? { ...item, ...change } : item)) ??
        current,
    );
  }

  /** Сразу на экране, потом на сервере; не вышло — возвращается только это поле. */
  async function send(id: string, change: SubtaskChange, undo: SubtaskChange) {
    patch(id, change);
    try {
      await updateTask(id, change);
      // Ошибка снимается по успеху, а не в начале: правка уходит по `blur`, то есть уже на
      // нажатии мыши, и окно, став короче, увело бы кнопку «Сохранить» из-под курсора.
      setError(null);
      return true;
    } catch (cause) {
      patch(id, undo);
      setError(messageOf(cause, "Не удалось сохранить"));
      return false;
    }
  }

  function save(id: string, change: SubtaskChange, undo: SubtaskChange) {
    const run = send(id, change, undo);
    saves.current.add(run);
    void run.finally(() => saves.current.delete(run));
  }

  async function remove(item: Subtask) {
    const index = list?.indexOf(item) ?? 0;
    setError(null);
    setList((current) => current?.filter((other) => other.id !== item.id) ?? current);
    try {
      await deleteTask(item.id);
    } catch (cause) {
      setList((current) =>
        current ? [...current.slice(0, index), item, ...current.slice(index)] : current,
      );
      setError(messageOf(cause, "Не удалось удалить"));
    }
  }

  function add(title: string): Promise<boolean> {
    setError(null);
    setText("");
    queue.current = queue.current.then(async () => {
      try {
        const created = await createTask({ title, parentId: taskId });
        setList((current) => [...(current ?? []), created]);
        return true;
      } catch (cause) {
        // Написанное не пропадает: поле получает его обратно, а упавшие подряд копятся.
        setText((current) => (current ? `${current}, ${title}` : title));
        setError(messageOf(cause, "Не удалось добавить"));
        return false;
      }
    });
    return queue.current;
  }

  useImperativeHandle(ref, () => ({
    flush: async () => {
      const title = text.trim();
      // Прежний сбой уже на экране, и поле человек очистил сам: мешать сохранению нечем.
      const added = title ? await add(title) : (await queue.current, true);
      const saved = await Promise.all(saves.current);
      return added && saved.every(Boolean);
    },
  }));

  const progress = list && list.length > 0 ? progressOf(list) : null;

  if (failed) {
    return (
      <Block>
        <div className="mt-2">
          <ErrorNote>Не удалось загрузить подзадачи</ErrorNote>
        </div>
      </Block>
    );
  }

  return (
    <Block count={progress ? `${progress.done} из ${progress.total}` : undefined}>
      {list && list.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {list.map((item) => {
            const done = item.status === "done";
            return (
              <li key={item.id} className="group flex min-h-9 items-center gap-1.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={done}
                  aria-label={`Готово: ${item.title}`}
                  onClick={() =>
                    save(
                      item.id,
                      { status: done ? "todo" : "done" },
                      { status: item.status },
                    )
                  }
                  className="group/check flex size-7 shrink-0 items-center justify-center"
                >
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full transition",
                      done
                        ? "bg-accent text-accent-foreground"
                        : "ring-foreground/20 group-hover/check:ring-foreground/50 group-hover/check:text-muted-foreground text-transparent ring-2 ring-inset",
                    )}
                  >
                    <Check size={13} strokeWidth={3} />
                  </span>
                </button>

                <TitleField
                  title={item.title}
                  label={`Название: ${item.title}`}
                  done={done}
                  onCommit={(title) => save(item.id, { title }, { title: item.title })}
                />

                <DeveloperPicker
                  compact
                  label={`Кто делает: ${item.title}`}
                  placeholder="Назначить"
                  value={item.developers}
                  onChange={(developers) =>
                    save(item.id, { developers }, { developers: item.developers })
                  }
                />

                <RemoveButton
                  label={`Удалить: ${item.title}`}
                  onClick={() => void remove(item)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <AddField
        value={text}
        onChange={setText}
        onAdd={(title) => void add(title)}
        count={list?.length ?? 0}
        disabled={list === null}
      />

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Block>
  );
}

/**
 * Черновик в новой задаче: только названия. Поле ввода управляется снаружи, потому что
 * форма добавит к списку и то, на чём не нажали Enter.
 */
export function SubtasksDraft({
  titles,
  onChange,
  text,
  onTextChange,
}: {
  titles: string[];
  onChange: (titles: string[]) => void;
  text: string;
  onTextChange: (text: string) => void;
}) {
  return (
    <Block count={titles.length > 0 ? String(titles.length) : undefined}>
      {titles.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {titles.map((title, index) => (
            <li key={index} className="group flex min-h-9 items-center gap-1.5">
              <TitleField
                title={title}
                label={`Название: ${title}`}
                onCommit={(next) =>
                  onChange(titles.map((item, at) => (at === index ? next : item)))
                }
              />
              <RemoveButton
                label={`Убрать: ${title}`}
                onClick={() => onChange(titles.filter((_, at) => at !== index))}
              />
            </li>
          ))}
        </ul>
      )}

      <AddField
        value={text}
        onChange={onTextChange}
        onAdd={(title) => {
          onChange([...titles, title]);
          onTextChange("");
        }}
        count={titles.length}
      />
    </Block>
  );
}

/**
 * Подзадачи черновика на сервере, строго по очереди, ради порядка. Возвращает то, что
 * сохранить не удалось: задача уже создана, и повторять её нельзя.
 */
export async function saveDraftSubtasks(
  parentId: string,
  titles: string[],
): Promise<string[]> {
  for (const [index, title] of titles.entries()) {
    try {
      await createTask({ title, parentId });
    } catch {
      return titles.slice(index);
    }
  }
  return [];
}
