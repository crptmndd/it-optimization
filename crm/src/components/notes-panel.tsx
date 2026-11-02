import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { ApiError } from "@/api/client";
import type { Note } from "@/api/leads";
import { memberLabel } from "@/api/team";
import { Button, ErrorNote, LoadingRows, Textarea } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { PersonChip } from "./person-chip";

export interface NotesHandle {
  /**
   * Добавить то, что вписано в поле, но не отправлено. Вызывается перед сохранением окна:
   * человек видит текст и считает, что он никуда не денется. `false` — не вышло, ошибка
   * уже на экране.
   */
  flush: () => Promise<boolean>;
}

/**
 * Заметки к записи — одинаково у лида, проекта, задачи и клиента.
 *
 * Хранятся одной полиморфной таблицей на сервере, поэтому и здесь один
 * компонент: четыре копии этой формы разошлись бы поведением на второй правке.
 * Загрузка и отправка приходят снаружи — компонент не знает, к чему привязан.
 */
export function NotesPanel({
  ref,
  load,
  add,
  hint,
}: {
  ref?: Ref<NotesHandle>;
  load: () => Promise<Note[]>;
  add: (body: string) => Promise<Note>;
  hint?: string;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Заметка в пути: «Сохранить» сразу за «Добавить заметку» не должно завести вторую. */
  const sending = useRef<Promise<boolean> | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    load()
      .then(setNotes)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setNotes([]);
      });
  }, [load]);

  useEffect(refresh, [refresh]);

  async function send(body: string): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const note = await add(body);
      // Дописываем в конец, не перезагружая список: хронология сверху вниз, и
      // ответ сервера уже содержит автора и время.
      setNotes((current) => [...(current ?? []), note]);
      setDraft("");
      return true;
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      return false;
    } finally {
      sending.current = null;
      setSaving(false);
    }
  }

  function submit(): Promise<boolean> {
    if (sending.current) return sending.current;
    const body = draft.trim();
    if (!body) return Promise.resolve(true);
    sending.current = send(body);
    return sending.current;
  }

  useImperativeHandle(ref, () => ({ flush: submit }));

  return (
    <NotesView
      notes={notes}
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={() => void submit()}
      saving={saving}
      error={error}
      hint={hint}
    />
  );
}

/**
 * Вид отдельно от данных: карточка лида получает заметки одним запросом вместе с самим
 * лидом, и `NotesPanel` с его загрузкой дал бы лишний запрос ради той же картинки.
 */
export function NotesView({
  notes,
  draft,
  onDraftChange,
  onSubmit,
  saving = false,
  error,
  hint = "Пока пусто. Здесь удобно держать то, что не влезает в поля.",
  placeholder = "Что обсудили, о чём договорились",
}: {
  /** `null` — ещё загружаются. */
  notes: Note[] | null;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  saving?: boolean;
  error?: string | null;
  hint?: string;
  placeholder?: string;
}) {
  /*
   * ⌘Enter здесь добавляет заметку и дальше не идёт: у окна вокруг он значит «сохранить
   * и закрыть», а человек в этом поле говорит о заметке.
   */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    if (draft.trim() && !saving) onSubmit();
  }

  return (
    <div>
      <h3 className="text-[15px] font-bold tracking-tight">Заметки</h3>

      {notes === null ? (
        <div className="mt-2">
          <LoadingRows rows={2} />
        </div>
      ) : notes.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">{hint}</p>
      ) : (
        <ul className="divide-border mt-1 divide-y">
          {notes.map((note) => {
            const author = memberLabel(note.author) || "Кто-то";
            return (
              <li key={note.id} className="flex gap-2.5 py-2.5">
                <PersonChip name={author} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-semibold">{author}</span>
                    <span className="text-muted-foreground text-xs font-medium">
                      {formatDateTime(note.createdAt)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">
                    {note.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-3">
        <Textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={placeholder}
          aria-label="Новая заметка"
        />
        {/* type="button": форма записи снаружи, и submit сохранил бы её целиком.
            Лайм занят главной кнопкой окна. */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={onSubmit}
          disabled={saving || !draft.trim()}
        >
          {saving ? "Сохраняем…" : "Добавить заметку"}
        </Button>
      </div>
    </div>
  );
}
