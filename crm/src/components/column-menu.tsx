import {
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "@/api/client";
import {
  COLUMN_KIND_HINTS,
  COLUMN_KIND_LABELS,
  createColumn,
  deleteColumn,
  renameColumn,
  reorderColumns,
  type BoardColumnDef,
} from "@/api/columns";
import { cn } from "@/lib/cn";
import { panelClass, useDropdown } from "./dropdown";
import { Button, ErrorNote, Field, Input, Modal } from "./ui";

/**
 * Управление колонками доски, только у админа: меню в шапке колонки. Новая колонка
 * заводится тоже отсюда, «Добавить справа», и сразу встаёт на место. Ошибки окон
 * показываются в самих окнах: удаление могли отклонить за секунду до того, и причину
 * человек должен видеть рядом с кнопкой.
 */
export function ColumnMenu({
  column,
  columns,
  onError,
}: {
  column: BoardColumnDef;
  /** Все колонки этой доски по порядку: для сдвига и для проверки «последняя своего типа». */
  columns: BoardColumnDef[];
  onError: (message: string) => void;
}) {
  const { open, setOpen, present, box, trigger, panel } = useDropdown<HTMLButtonElement>({
    panelWidth: 220,
    panelHeight: 250,
  });
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);

  const index = columns.findIndex((item) => item.id === column.id);
  const lastOfKind = columns.filter((item) => item.kind === column.kind).length === 1;

  async function shift(by: -1 | 1) {
    setOpen(false);
    const ids = columns.map((item) => item.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    ids.splice(target, 0, ...ids.splice(index, 1));
    try {
      await reorderColumns(column.scope, ids);
    } catch (cause) {
      onError(cause instanceof ApiError ? cause.message : "Не удалось переставить");
    }
  }

  const item =
    "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium transition hover:bg-muted disabled:opacity-45 disabled:hover:bg-transparent";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Колонка «${column.title}»: действия`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground hover:bg-ink/[0.06] flex size-7 items-center justify-center rounded-lg transition"
      >
        <MoreHorizontal size={16} strokeWidth={2.25} />
      </button>

      {present &&
        box &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width }}
            className={cn(
              panelClass,
              "p-1.5",
              open ? "crm-pop-in" : "crm-pop-out pointer-events-none",
            )}
          >
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                setRenaming(true);
              }}
            >
              <Pencil size={15} strokeWidth={2.25} className="text-muted-foreground" />
              Переименовать
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={index <= 0}
              onClick={() => void shift(-1)}
            >
              <ArrowLeft size={15} strokeWidth={2.25} className="text-muted-foreground" />
              Левее
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={index === columns.length - 1}
              onClick={() => void shift(1)}
            >
              <ArrowRight
                size={15}
                strokeWidth={2.25}
                className="text-muted-foreground"
              />
              Правее
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                setAdding(true);
              }}
            >
              <Plus size={15} strokeWidth={2.25} className="text-muted-foreground" />
              Добавить справа
            </button>
            <button
              type="button"
              role="menuitem"
              className={cn(item, "text-danger")}
              disabled={lastOfKind}
              title={
                lastOfKind
                  ? `Последняя колонка типа «${COLUMN_KIND_LABELS[column.scope][column.kind]}»`
                  : undefined
              }
              onClick={() => {
                setOpen(false);
                setDeleting(true);
              }}
            >
              <Trash2 size={15} strokeWidth={2.25} />
              Удалить
            </button>
            {lastOfKind && (
              <p className="text-muted-foreground px-2.5 pt-1 pb-1.5 text-xs">
                Последнюю колонку типа «{COLUMN_KIND_LABELS[column.scope][column.kind]}»
                удалить нельзя, только переименовать
              </p>
            )}
          </div>,
          document.body,
        )}

      {renaming && <RenameModal column={column} onClose={() => setRenaming(false)} />}
      {adding && (
        <CreateModal after={column} columns={columns} onClose={() => setAdding(false)} />
      )}
      {deleting && (
        <DeleteModal
          column={column}
          columns={columns}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

function RenameModal({
  column,
  onClose,
}: {
  column: BoardColumnDef;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(column.title);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await renameColumn(column.id, title.trim());
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setPending(false);
    }
  }

  return (
    <Modal title="Название колонки" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="Название">
          <Input
            autoFocus
            value={title}
            maxLength={40}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" className="w-full" disabled={pending || !title.trim()}>
          Сохранить
        </Button>
      </form>
    </Modal>
  );
}

function DeleteModal({
  column,
  columns,
  onClose,
}: {
  column: BoardColumnDef;
  columns: BoardColumnDef[];
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const target = columns.find(
    (item) => item.kind === column.kind && item.id !== column.id,
  );
  const cards = column.scope === "task" ? "Задачи" : "Проекты";

  async function confirm() {
    setError(null);
    setPending(true);
    try {
      await deleteColumn(column.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setPending(false);
    }
  }

  return (
    <Modal title={`Удалить «${column.title}»?`} onClose={onClose}>
      <p className="text-muted-foreground text-sm">
        {cards} из неё перейдут в конец колонки «{target?.title ?? "того же типа"}».
        Статус у них не изменится.
      </p>
      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      <div className="mt-5 flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onClose}>
          Отмена
        </Button>
        <Button
          className="bg-danger hover:bg-danger flex-1 text-white hover:opacity-90"
          disabled={pending}
          onClick={() => void confirm()}
        >
          Удалить
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Новая колонка справа от `after`. Тип по умолчанию — как у соседа: справа от «В работе»
 * обычно ставят ещё один этап работы. Сервер заводит колонку в конце, а порядок здесь же
 * переставляется так, чтобы она встала куда просили.
 */
function CreateModal({
  after,
  columns,
  onClose,
}: {
  after: BoardColumnDef;
  columns: BoardColumnDef[];
  onClose: () => void;
}) {
  const scope = after.scope;
  const kinds = Object.keys(COLUMN_KIND_LABELS[scope]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState(after.kind);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await createColumn({ scope, title: title.trim(), kind });
      const ids = columns.map((column) => column.id);
      ids.splice(ids.indexOf(after.id) + 1, 0, created.id);
      await reorderColumns(scope, ids);
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось создать");
      setPending(false);
    }
  }

  return (
    <Modal title={`Новая колонка после «${after.title}»`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <Field label="Название">
          <Input
            autoFocus
            value={title}
            maxLength={40}
            placeholder={scope === "task" ? "Например, на проверке" : "Например, дизайн"}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <div>
          <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
            Что это для системы
          </span>
          <div role="radiogroup" aria-label="Тип колонки" className="space-y-1.5">
            {kinds.map((value) => (
              <label
                key={value}
                className={cn(
                  "bg-field flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition",
                  kind === value && "ring-accent ring-2",
                )}
              >
                <input
                  type="radio"
                  name="column-kind"
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                  className="accent-accent mt-1"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">
                    {COLUMN_KIND_LABELS[scope][value]}
                  </span>
                  <span className="text-muted-foreground block text-xs">
                    {COLUMN_KIND_HINTS[scope][value]}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-muted-foreground mt-1.5 text-xs">
            Тип потом не меняется: от него зависят «Сегодня», сводка и счета.
          </p>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" className="w-full" disabled={pending || !title.trim()}>
          Создать колонку
        </Button>
      </form>
    </Modal>
  );
}
