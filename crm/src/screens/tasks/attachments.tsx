import { FileText, Paperclip, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, apiUrl } from "@/api/client";
import {
  deleteTaskAttachment,
  uploadTaskAttachment,
  type TaskAttachment,
} from "@/api/tasks";
import { Button, ErrorNote } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * Файлы задачи: скриншоты, документы от клиента. Чаще всего приходят из телеграма вместе с
 * поручением, но прикрепить можно и здесь — кнопкой или перетащив файл на блок. Как и
 * подзадачи, всё сохраняется сразу, без кнопки «Сохранить» у окна.
 *
 * Картинки показаны миниатюрами, остальное — строкой со значком. Открываются по ссылке на
 * API: файл отдаётся только вошедшему и только тем, кому видна задача.
 */

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

export function AttachmentsPanel({
  taskId,
  load,
}: {
  taskId: string;
  /** Из той же карточки, что подзадачи и заметки: окно делает один запрос. */
  load: Promise<TaskAttachment[]>;
}) {
  const [list, setList] = useState<TaskAttachment[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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

  async function remove(item: TaskAttachment) {
    if (!confirm(`Удалить «${item.fileName}»?`)) return;
    const index = list?.indexOf(item) ?? 0;
    setError(null);
    setList((current) => current?.filter((other) => other.id !== item.id) ?? current);
    try {
      await deleteTaskAttachment(taskId, item.id);
    } catch (cause) {
      setList((current) =>
        current ? [...current.slice(0, index), item, ...current.slice(index)] : current,
      );
      setError(messageOf(cause, "Не удалось удалить"));
    }
  }

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

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "-m-2 rounded-xl p-2 transition",
        dragging && "bg-accent-soft ring-accent ring-2",
      )}
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-[15px] font-bold tracking-tight">Файлы</h3>
        {list && list.length > 0 && (
          <span className="text-muted-foreground text-[13px] font-semibold tabular-nums">
            {list.length}
          </span>
        )}
      </div>

      {images.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {images.map((item) => (
            <li key={item.id} className="group relative">
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
                onClick={() => void remove(item)}
                className="bg-surface text-muted-foreground hover:text-danger absolute top-1 right-1 flex size-6 items-center justify-center rounded-md shadow transition group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
              >
                <Trash2 size={13} strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {others.map((item) => (
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
                onClick={() => void remove(item)}
                className="text-muted-foreground hover:bg-danger-soft hover:text-danger flex size-7 shrink-0 items-center justify-center rounded-lg transition group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
              >
                <Trash2 size={15} strokeWidth={2.25} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-center gap-3">
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
        {uploading > 0 && (
          <span className="text-muted-foreground text-[13px]">Загружаем…</span>
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

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}
