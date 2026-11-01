import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

/**
 * Открывает карточку, на которую указывает `?open=<id>` из глобального поиска.
 *
 * Экраны показывают записи в модальных окнах и своих адресов у карточек нет,
 * поэтому поиск переводит в раздел и просит открыть нужную. Ждать приходится
 * загрузки списка: до неё открывать нечего.
 *
 * `fetchMissing` — на случай, когда записи нет в загруженном списке: архивный
 * проект в него не входит, но открываться из поиска и «Счетов» обязан. Иначе
 * параметр так и остался бы висеть в адресе. Функция должна быть стабильной
 * (`useCallback`) и вернуть `null`, если запись не нашлась.
 */
export function useOpenFromSearch<T extends { id: string }>(
  items: T[] | null,
  open: (item: T) => void,
  fetchMissing?: (id: string) => Promise<T | null>,
): void {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("open");
  // Что уже открывали. Очистка параметра доходит не мгновенно, и без отметки
  // эффект успевает сработать второй раз на том же идентификаторе.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    // Отметка живёт, только пока параметр в адресе: экран не перемонтируется, и
    // повторный поиск той же записи иначе ничего бы не открыл.
    if (!wanted) {
      handled.current = null;
      return;
    }
    if (!items || handled.current === wanted) return;

    const found = items.find((item) => item.id === wanted);
    if (!found && !fetchMissing) return;

    handled.current = wanted;
    // Параметр убирается сразу: иначе закрытая карточка открывалась бы снова
    // при каждом обновлении списка, и закрыть её было бы нельзя.
    if (found) {
      open(found);
      setParams({}, { replace: true });
      return;
    }

    void fetchMissing!(wanted).then((item) => {
      if (item) open(item);
      setParams({}, { replace: true });
    });
  }, [wanted, items, open, fetchMissing, setParams]);
}
