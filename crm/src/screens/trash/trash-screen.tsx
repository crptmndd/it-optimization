import { RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import {
  emptyTrash,
  getTrash,
  purgeItem,
  restoreItem,
  type TrashItem,
} from "@/api/trash";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  PageHeader,
} from "@/components/ui";
import { daysFromToday, formatDate } from "@/lib/dates";

/**
 * Корзина.
 *
 * До неё удаление было односторонним: запись исчезала с экрана и оставалась в
 * базе навсегда — вернуть нельзя, а место занимает. Теперь у мягкого удаления
 * появился смысл: тридцать дней на передумать, потом чисто.
 */
export function TrashScreen() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [retention, setRetention] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    getTrash()
      .then((trash) => {
        setItems(trash.items);
        setRetention(trash.retentionDays);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setItems([]);
      });
  }, []);

  useEffect(load, [load]);

  async function act(item: TrashItem, action: "restore" | "purge") {
    if (
      action === "purge" &&
      !confirm(`Удалить «${item.title}» насовсем? Вернуть будет нельзя.`)
    ) {
      return;
    }

    setBusy(item.id);
    setError(null);
    try {
      await (action === "restore"
        ? restoreItem(item.entity, item.id)
        : purgeItem(item.entity, item.id));
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  async function empty() {
    const count = items?.length ?? 0;
    // Счёт прямо в вопросе: «очистить корзину?» звучит безобидно, а за ним
    // может стоять проект, который кто-то удалил по ошибке неделю назад.
    if (!confirm(`Удалить насовсем ${count} зап. из корзины? Вернуть будет нельзя.`)) {
      return;
    }

    setEmptying(true);
    setError(null);
    try {
      await emptyTrash();
      load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не получилось очистить");
    } finally {
      setEmptying(false);
    }
  }

  return (
    <section>
      <PageHeader
        title="Корзина"
        subtitle={`Удалённое хранится ${retention} дней. Проект возвращается вместе с задачами и заметками`}
      >
        <Button
          variant="danger"
          onClick={() => void empty()}
          disabled={emptying || !items?.length}
        >
          <Trash2 size={17} strokeWidth={2.25} />
          {emptying ? "Очищаем…" : "Очистить корзину"}
        </Button>
      </PageHeader>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {items === null ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <EmptyState title="Пусто" note="Ничего удалённого — и хорошо." />
        ) : (
          <List>
            {items.map((item) => (
              <Row
                key={`${item.entity}:${item.id}`}
                item={item}
                retention={retention}
                busy={busy === item.id}
                onRestore={() => void act(item, "restore")}
                onPurge={() => void act(item, "purge")}
              />
            ))}
          </List>
        )}
      </div>
    </section>
  );
}

function Row({
  item,
  retention,
  busy,
  onRestore,
  onPurge,
}: {
  item: TrashItem;
  retention: number;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  // Сколько осталось, а не когда удалили: решение принимают по остатку срока.
  const left = retention + daysFromToday(item.deletedAt);

  return (
    // Все пять колонок только с xl: с боковой колонкой ниже им не хватает ширины.
    // Строка не открывает ничего, поэтому подсветки при наведении у неё нет.
    <li className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_7.5rem_auto] xl:grid-cols-[minmax(0,1fr)_7rem_11rem_7.5rem_auto]">
      {/* На xl обёртка растворяется, и тип с датой становятся колонками сетки. */}
      <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 xl:contents">
        <span className="w-full truncate text-[15px] font-semibold xl:w-auto">
          {item.title}
        </span>
        <span className="text-muted-foreground truncate text-[13px] font-medium">
          {item.label}
        </span>
        {/* Без «удалён»: подписи приходят с сервера и бывают женского рода
            («Статья»), а согласовать род на клиенте не по чему. */}
        <span className="text-muted-foreground truncate text-[13px] font-medium">
          в корзине с {formatDate(item.deletedAt)}
        </span>
      </div>

      <span className="flex justify-end">
        <Badge tone={left <= 3 ? "danger" : "neutral"}>
          {left <= 0 ? "вот-вот исчезнет" : `${left} дн.`}
        </Badge>
      </span>

      <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
        <Button variant="secondary" size="sm" onClick={onRestore} disabled={busy}>
          <RotateCcw size={15} strokeWidth={2.25} />
          Восстановить
        </Button>
        <button
          type="button"
          onClick={onPurge}
          disabled={busy}
          aria-label="Удалить насовсем"
          title="Удалить насовсем"
          className="text-muted-foreground hover:bg-muted hover:text-danger flex size-8 items-center justify-center rounded-lg transition disabled:opacity-50"
        >
          <Trash2 size={17} strokeWidth={2.25} />
        </button>
      </div>
    </li>
  );
}
