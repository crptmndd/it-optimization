import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { search, type SearchHit } from "@/api/search";
import { cn } from "@/lib/cn";

/**
 * Поиск по всей CRM.
 *
 * Раньше, чтобы найти «Парки Казани», надо было помнить, в каком разделе они
 * лежат. Здесь достаточно названия, контакта или обрывка заметки — раздел
 * подскажет сама выдача.
 *
 * Результат ведёт не в раздел, а прямо к карточке: через `?open=<id>`, который
 * экран разбирает сам. Иначе поиск заканчивался бы там, где начинается ручной
 * просмотр списка.
 */

/** Пауза перед запросом: за это время дописывают слово, а не букву. */
const DEBOUNCE_MS = 250;

/** Короче двух символов совпадёт половина базы — сервер такое и не ищет. */
const MIN_LENGTH = 2;

export function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const text = query.trim();
    if (text.length < MIN_LENGTH) {
      setHits(null);
      return;
    }

    setBusy(true);
    const timer = setTimeout(() => {
      search(text)
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  // Клик мимо закрывает выдачу: иначе она висит поверх экрана, пока не сотрёшь
  // запрос руками.
  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (!box.current?.contains(event.target as Node)) setHits(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function go(hit: SearchHit) {
    setQuery("");
    setHits(null);
    navigate(`/${hit.entity}?open=${hit.id}`);
  }

  return (
    <div ref={box} className="relative w-full">
      <Search
        size={15}
        strokeWidth={2}
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
      />
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setHits(null)}
        placeholder="Поиск по CRM"
        aria-label="Поиск по всей CRM"
        className="bg-background shadow-card placeholder:text-muted-foreground focus:ring-accent h-10 w-full rounded-xl pr-8 pl-9 text-sm font-medium transition outline-none placeholder:font-normal focus:ring-2"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label="Очистить"
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1"
        >
          <X size={13} strokeWidth={2.5} />
        </button>
      )}

      {hits !== null && (
        <div className="bg-popover shadow-float absolute top-full right-0 left-0 z-50 mt-1.5 max-h-80 overflow-y-auto rounded-2xl p-1.5 md:w-80">
          {hits.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2 text-sm">
              {busy ? "Ищем…" : "Ничего не нашлось"}
            </p>
          ) : (
            hits.map((hit) => (
              <button
                key={`${hit.entity}:${hit.id}`}
                type="button"
                onClick={() => go(hit)}
                className={cn(
                  "hover:bg-muted flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {hit.title}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {hit.label}
                    {hit.hint && ` · ${hit.hint}`}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
