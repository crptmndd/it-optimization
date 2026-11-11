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
import {
  noteProblem,
  NotesPanel,
  NotesView,
  type NotesHandle,
} from "@/components/notes-panel";
import { Button, ErrorNote, Modal } from "@/components/ui";
import {
  SubtasksDraft,
  SubtasksPanel,
  type DraftSubtask,
  type SubtasksHandle,
} from "./subtasks";
import { AttachmentsPanel } from "./attachments";
import { TaskFields, type TaskFormValues } from "./task-form";

/** Окно задачи: и новой, и заведённой. У новой заметка и подзадачи пока только черновики. */
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
  archive,
  onProgress,
}: {
  title: string;
  submitLabel?: string;
  initial: TaskFormValues;
  projects: Project[];
  current?: { id: string; title: string } | null;
  /** Есть только у сохранённой задачи: вешать заметки и подзадачи пока не на что. */
  taskId?: string;
  editing?: boolean;
  /** Ошибка, с которой окно открывается: задача создалась, а подзадачи нет. */
  notice?: string | null;
  onClose: () => void;
  /** `subtasks` и `note` — черновики новой задачи, у сохранённой всегда пусты. */
  onSubmit: (
    values: TaskFormValues,
    subtasks: DraftSubtask[],
    note: string,
  ) => Promise<void>;
  onDelete?: () => Promise<void>;
  /** Ручной архив, только у админа: одно из двух, в зависимости от того, где задача. */
  archive?: { label: "В архив" | "Вернуть из архива"; run: () => Promise<void> };
  onProgress: (taskId: string, progress: SubtaskProgress) => void;
}) {
  const [values, setValues] = useState<TaskFormValues>(initial);
  const [error, setError] = useState<string | null>(notice);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<DraftSubtask[]>([]);
  const [draftText, setDraftText] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const panel = useRef<SubtasksHandle>(null);
  const notes = useRef<NotesHandle>(null);

  // Один ответ на подзадачи и заметки: оба блока стоят на одной карточке задачи.
  const [card] = useState(() => (taskId ? getTask(taskId) : null));
  const subtaskList = useMemo(() => card?.then(({ task }) => task.subtaskList), [card]);
  const attachments = useMemo(
    () => card?.then(({ task }) => task.attachments ?? []),
    [card],
  );
  // Функция постоянная, иначе заметки перезапрашивались бы на каждую букву в форме.
  const loadNotes = useCallback(async () => (await card)?.notes ?? [], [card]);

  /**
   * Окно закроется вместе с тем, что вписано, но не отправлено. Текст на экране — не
   * черновик, который можно молча потерять, поэтому при сбое окно остаётся.
   */
  async function flushBlocks(): Promise<boolean> {
    return (
      (await panel.current?.flush()) !== false && (await notes.current?.flush()) !== false
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // ⌘Enter шлёт форму мимо выключенной кнопки, а с подзадачами сохранение идёт дольше:
    // второе нажатие завело бы вторую задачу.
    if (saving) return;
    // Заметка новой задачи едет в том же запросе: слишком длинная отклонила бы задачу целиком.
    const problem = noteProblem(noteDraft);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (!(await flushBlocks())) {
        setSaving(false);
        return;
      }
      const typed = draftText.trim();
      const items = typed
        ? [...draft, { title: typed, done: false, developers: [] }]
        : draft;
      await onSubmit(values, items, noteDraft.trim());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!archive) return;
    setError(null);
    setSaving(true);
    try {
      if (!(await flushBlocks())) {
        setSaving(false);
        return;
      }
      await archive.run();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось");
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

  // Из поля заметки ⌘Enter тоже приходит сюда: заметку добавит `flushBlocks`. Отправка не
  // сразу: поле подзадачи отдаёт правку по `blur`, и она должна успеть попасть в состояние
  // окна.
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
          initialDevelopers={initial.developers}
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
              items={draft}
              onChange={setDraft}
              text={draftText}
              onTextChange={setDraftText}
            />
          )}
        </div>

        {taskId && attachments && (
          <div className="mt-5">
            <AttachmentsPanel taskId={taskId} load={attachments} />
          </div>
        )}

        <div className="mt-5">
          {taskId ? (
            <NotesPanel
              ref={notes}
              load={loadNotes}
              add={(body) => addTaskNote(taskId, body)}
              savedWithForm
            />
          ) : (
            <NotesView
              notes={[]}
              draft={noteDraft}
              onDraftChange={setNoteDraft}
              savedWithForm
            />
          )}
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : submitLabel}
          </Button>
          {archive && (
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              onClick={() => void handleArchive()}
              disabled={saving}
            >
              {archive.label}
            </Button>
          )}
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
