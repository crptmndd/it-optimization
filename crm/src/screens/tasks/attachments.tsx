import { Check, FileText, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, apiUrl } from "@/api/client";
import {
  deleteTaskAttachment,
  deleteTaskAttachments,
  uploadTaskAttachment,
  type TaskAttachment,
} from "@/api/tasks";
import { Button, ErrorNote } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Файлы задачи: скриншоты, документы от клиента. Чаще всего приходят из телеграма вместе с
 * поручением, но прикрепить можно и здесь — кнопкой, перетащив файл на блок или вставив
 * из буфера обмена (Ctrl+V в любом месте окна). Как и подзадачи, всё сохраняется сразу,
 * без кнопки «Сохранить» у окна.
 *
 * Удалить можно один файл, выбранные или все разом. Картинки показаны миниатюрами,
 * остальное — строкой со значком. Открываются по ссылке на API: файл отдаётся только
 * вошедшему и только тем, кому видна задача.
 */

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

function filesWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "файлов";
  if (ones === 1) return "файл";
  if (ones >= 2 && ones <= 4) return "файла";
  return "файлов";
}

const PASTE_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘V"
    : "Ctrl+V";

/**
 * Скриншот из буфера браузер называет «image.png», и в списке их было бы десять
 * одинаковых. Даём имя со временем, как у скриншотов в системе.
 */
function named(file: File): File {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const extension = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg");
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return new File([file], `Скриншот ${stamp}.${extension}`, { type: file.type });
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA")
  );
}

/** Кружок выбора — того же вида, что у подзадач и строк задач. */
function Tick({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full transition",
        on
          ? "bg-accent text-accent-foreground"
          : "bg-background/90 ring-foreground/30 ring-2 ring-inset",
        className,
      )}
    >
      {on && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

export function AttachmentsPanel({
  taskId,
  load,
  onCount,
}: {
  taskId: string;
  /** Сколько файлов стало: метке на карточке за окном незачем ждать перезагрузки. */
  onCount?: (taskId: string, count: number) => void;
  /** Из той же карточки, что подзадачи и заметки: окно делает один запрос. */
  load: Promise<TaskAttachment[]>;
}) {
  const [list, setList] = useState<TaskAttachment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Режим выбора: миниатюры и строки не открываются, а отмечаются для удаления. */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    load.then((items) => alive && setList(items)).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [load]);

  /** По одному: так порядок на экране — это порядок загрузки, а сбой называет свой файл. */
  async function add(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setUploading((count) => count + files.length);
    for (const file of files) {
      try {
        const saved = await uploadTaskAttachment(taskId, file);
        setList((current) => [...(current ?? []), saved]);
      } catch (cause) {
        setError(`«${file.name}»: ${messageOf(cause, "не удалось загрузить")}`);
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }

  /**
   * Вставка из буфера ловится во всём окне, а не только над блоком: снял скриншот, открыл
   * задачу, нажал Ctrl+V — и он здесь. Пока файлы не загрузились, вставку не берём: ответ
   * загрузки лёг бы поверх только что прикреплённого.
   */
  const addLatest = useRef(add);
  useEffect(() => {
    addLatest.current = add;
  });
  const ready = list !== null;
  useEffect(() => {
    if (!ready) return;
    function onPaste(event: ClipboardEvent) {
      const data = event.clipboardData;
      const files = [...(data?.files ?? [])];
      if (files.length === 0) return;
      // Текст из Word или Excel везёт с собой ещё и свою картинку: в поле ввода это
      // вставка текста, а не файла.
      if (isEditable(event.target) && data?.types.includes("text/plain")) return;
      event.preventDefault();
      root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      void addLatest.current(files.map(named));
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [ready]);

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Один, выбранные или все. Из списка уходят сразу, при сбое возвращаются на место. */
  async function remove(items: TaskAttachment[]) {
    if (items.length === 0) return;
    const question =
      items.length === 1
        ? `Удалить «${items[0]!.fileName}»?`
        : `Удалить ${items.length} ${filesWord(items.length)}? Вернуть их будет нельзя.`;
    if (!confirm(question)) return;
    const ids = new Set(items.map((item) => item.id));
    setError(null);
    setList((current) => current?.filter((item) => !ids.has(item.id)) ?? current);
    stopSelecting();
    try {
      if (items.length === 1) await deleteTaskAttachment(taskId, items[0]!.id);
      else await deleteTaskAttachments(taskId, [...ids]);
    } catch (cause) {
      setList((current) =>
        current
          ? [...current, ...items].sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            )
          : current,
      );
      setError(messageOf(cause, "Не удалось удалить"));
    }
  }

  useEffect(() => {
    if (list) onCount?.(taskId, list.length);
  }, [list, taskId, onCount]);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void add([...event.dataTransfer.files]);
  }

  if (failed) {
    return <ErrorNote>Не удалось загрузить файлы</ErrorNote>;
  }

  const images = list?.filter((item) => item.image) ?? [];
  const others = list?.filter((item) => !item.image) ?? [];
  const all = list ?? [];
  const chosen = all.filter((item) => selected.has(item.id));

  return (
    <div
      ref={root}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "-m-2 scroll-m-4 rounded-xl p-2 transition",
        dragging && "bg-accent-soft ring-accent ring-2",
      )}
    >
      <div className="flex min-h-8 items-center gap-2">
        <h3 className="text-[15px] font-bold tracking-tight">Файлы</h3>
        {all.length > 0 && (
          <span className="text-muted-foreground text-[13px] font-semibold tabular-nums">
            {all.length}
          </span>
        )}
        {/* Один файл удаляет своя корзинка, выбирать там нечего. */}
        {all.length > 1 && (
          <div className="ml-auto flex items-center gap-1">
            {selecting ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSelected(
                      chosen.length === all.length
                        ? new Set()
                        : new Set(all.map((item) => item.id)),
                    )
                  }
                >
                  {chosen.length === all.length ? "Снять все" : "Выбрать все"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={stopSelecting}>
                  Отмена
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelecting(true)}
                >
                  Выбрать
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => void remove(all)}
                >
                  Удалить все
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {images.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {images.map((item) => {
            const on = selected.has(item.id);
            return (
              <li key={item.id} className="group relative">
                {selecting ? (
                  <button
                    type="button"
                    aria-pressed={on}
                    title={item.fileName}
                    onClick={() => toggle(item.id)}
                    className={cn(
                      "block size-20 overflow-hidden rounded-lg border transition",
                      on ? "border-accent ring-accent ring-2" : "border-border",
                    )}
                  >
                    <img
                      src={apiUrl(item.url)}
                      alt={item.fileName}
                      loading="lazy"
                      className={cn("size-full object-cover", on && "opacity-80")}
                    />
                    <Tick on={on} className="absolute top-1 left-1" />
                  </button>
                ) : (
                  <>
                    <a
                      href={apiUrl(item.url)}
                      target="_blank"
                      rel="noreferrer"
                      title={item.fileName}
                      className="border-border block size-20 overflow-hidden rounded-lg border"
                    >
                      <img
                        src={apiUrl(item.url)}
                        alt={item.fileName}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    </a>
                    <button
                      type="button"
                      aria-label={`Удалить: ${item.fileName}`}
                      title="Удалить"
                      onClick={() => void remove([item])}
                      className="bg-surface text-muted-foreground hover:text-danger absolute top-1 right-1 flex size-6 items-center justify-center rounded-md shadow transition group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
                    >
                      <Trash2 size={13} strokeWidth={2.25} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {others.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {others.map((item) =>
            selecting ? (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={selected.has(item.id)}
                  onClick={() => toggle(item.id)}
                  className="hover:bg-muted/60 -mx-1 flex min-h-9 w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg px-1 text-left transition"
                >
                  <Tick on={selected.has(item.id)} />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.fileName}</span>
                  <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                    {sizeOf(item.size)}
                  </span>
                </button>
              </li>
            ) : (
              <li key={item.id} className="group flex min-h-9 items-center gap-2">
                <FileText size={16} className="text-muted-foreground shrink-0" />
                <a
                  href={apiUrl(item.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  {item.fileName}
                </a>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {sizeOf(item.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Удалить: ${item.fileName}`}
                  title="Удалить"
                  onClick={() => void remove([item])}
                  className="text-muted-foreground hover:bg-danger-soft hover:text-danger flex size-7 shrink-0 items-center justify-center rounded-lg transition group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
                >
                  <Trash2 size={15} strokeWidth={2.25} />
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {selecting ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={chosen.length === 0}
            onClick={() => void remove(chosen)}
            className="bg-danger-soft"
          >
            <Trash2 size={14} strokeWidth={2.25} />
            {chosen.length > 0
              ? `Удалить выбранные (${chosen.length})`
              : "Удалить выбранные"}
          </Button>
          <span className="text-muted-foreground text-[13px]">
            Отметьте файлы, которые удалить
          </span>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => input.current?.click()}
            disabled={list === null}
          >
            <Paperclip size={14} strokeWidth={2.25} />
            Прикрепить файл
          </Button>
          {uploading > 0 ? (
            <span className="text-muted-foreground text-[13px]">Загружаем…</span>
          ) : (
            // На телефоне нечего перетаскивать и нечем нажать Ctrl+V.
            <span className="text-muted-foreground hidden text-[13px] md:inline">
              или перетащите сюда, или вставьте скриншот: {PASTE_KEY}
            </span>
          )}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // Тот же файл можно выбрать снова, если первая попытка сорвалась.
              event.target.value = "";
              void add(files);
            }}
          />
        </div>
      )}

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}
