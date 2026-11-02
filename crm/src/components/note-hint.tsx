import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Последняя заметка прямо в строке списка.
 *
 * Раньше заметки жили только внутри карточки, и «о чём мы вообще
 * договорились» приходилось выяснять, открывая каждую по очереди. Показывается
 * именно последняя: в переписке важно свежее, а не первое.
 */
export interface NoteBrief {
  body: string;
  author: string | null;
  createdAt: string;
  count: number;
}

/**
 * `note` — полиморфная заметка-комментарий (лиды, клиенты, проекты, задачи).
 * `text` — простое текстовое поле «Заметки» у клиента и доступа. Вид у них
 * один, чтобы человек не гадал, почему в двух разделах одно и то же выглядит
 * по-разному.
 */
export function NoteHint({
  note,
  text,
  className,
}: {
  note?: NoteBrief | null;
  text?: string | null;
  className?: string;
}) {
  const body = note?.body ?? text?.trim();
  if (!body) return null;

  return (
    // span, а не p: строка списка — это <button>, а абзац внутри кнопки
    // недопустим по разметке.
    <span
      className={cn(
        "text-muted-foreground mt-1.5 flex w-full items-start gap-1.5 text-xs font-medium",
        className,
      )}
    >
      <MessageSquare size={15} strokeWidth={2.25} className="shrink-0 opacity-60" />
      <span className="min-w-0 flex-1">
        {/* Две строки максимум: строка списка не должна превращаться в абзац. */}
        <span className="line-clamp-2">{body}</span>
        {note && (note.author || note.count > 1) && (
          <span className="mt-0.5 flex gap-2 font-normal">
            {note.author && <span className="truncate">{note.author}</span>}
            {note.count > 1 && <span className="shrink-0">ещё {note.count - 1}</span>}
          </span>
        )}
      </span>
    </span>
  );
}
