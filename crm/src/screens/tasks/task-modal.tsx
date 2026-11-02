import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ApiError } from "@/api/client";
import type { Project } from "@/api/projects";
import { addTaskNote, getTask, type SubtaskProgress } from "@/api/tasks";
import { NotesPanel, type NotesHandle } from "@/components/notes-panel";
import { Button, ErrorNote, Modal } from "@/components/ui";
import { SubtasksDraft, SubtasksPanel, type SubtasksHandle } from "./subtasks";
import { TaskFields, type TaskFormValues } from "./task-form";

/** Окно задачи: и новой, и заведённой. У новой нет ни заметок, ни настоящих подзадач. */
export function TaskModal({
  title,
  submitLabel = "Сохранить",
  initial,
  projects,
  current,
  taskId,
  editing,
  notice = null,
  onClose,
  onSubmit,
  onDelete,
  onProgress,
}: {
  title: string;
  submitLabel?: string;
  initial: TaskFormValues;
  projects: Project[];
  current?: { id: string; title: string } | null;
  /** Есть только у сохранённой задачи — заметки вешать не на что, пока её нет. */
  taskId?: string;
  editing?: boolean;
  /** Ошибка, с которой окно открывается: задача создалась, а подзадачи нет. */
  notice?: string | null;
  onClose: () => void;
  /** `subtasks` — черновик новой задачи, у сохранённой всегда пуст. */
  onSubmit: (values: TaskFormValues, subtasks: string[]) => Promise<void>;
  onDelete?: () => Promise<void>;
  onProgress: (taskId: string, progress: SubtaskProgress) => void;
}) {
  const [values, setValues] = useState<TaskFormValues>(initial);
  const [error, setError] = useState<string | null>(notice);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [draftText, setDraftText] = useState("");
  const panel = useRef<SubtasksHandle>(null);
  const notes = useRef<NotesHandle>(null);

  // Один ответ на подзадачи и заметки: оба блока стоят на одной карточке задачи.
  const [card] = useState(() => (taskId ? getTask(taskId) : null));
  const subtaskList = useMemo(() => card?.then(({ task }) => task.subtaskList), [card]);
  // Функция постоянная, иначе заметки перезапрашивались бы на каждую букву в форме.
  const loadNotes = useCallback(async () => (await card)?.notes ?? [], [card]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // ⌘Enter шлёт форму мимо выключенной кнопки, а с подзадачами сохранение идёт дольше:
    // второе нажатие завело бы вторую задачу.
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      // Окно закроется вместе с тем, что вписано, но не отправлено. Текст на экране — не
      // черновик, который можно молча потерять, поэтому при сбое окно остаётся.
      const flushed =
        (await panel.current?.flush()) !== false &&
        (await notes.current?.flush()) !== false;
      if (!flushed) {
        setSaving(false);
        return;
      }
      const titles = [...draft, draftText.trim()].filter(Boolean);
      await onSubmit(values, titles);
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

  // В поле заметки ⌘Enter свой, он добавляет заметку и сюда не доходит. Отправка не сразу:
  // поле подзадачи отдаёт правку по `blur`, и она должна успеть попасть в состояние окна.
  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const form = event.currentTarget;
      setTimeout(() => form.requestSubmit());
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit} onKeyDown={onKeyDown}>
        <TaskFields
          values={values}
          onChange={setValues}
          projects={projects}
          current={current}
          editing={editing}
        />

        <div className="mt-5">
          {taskId && subtaskList ? (
            <SubtasksPanel
              ref={panel}
              taskId={taskId}
              load={subtaskList}
              onProgress={onProgress}
            />
          ) : (
            <SubtasksDraft
              titles={draft}
              onChange={setDraft}
              text={draftText}
              onTextChange={setDraftText}
            />
          )}
        </div>

        {taskId && (
          <div className="mt-5">
            <NotesPanel
              ref={notes}
              load={loadNotes}
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

        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : submitLabel}
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="danger"
              className="h-11"
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
