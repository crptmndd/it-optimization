import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Segmented, type SegmentOption } from "./ui";

/**
 * Панель над списком: всё, что меняет вид списка, в одну линию. Фильтры слева, поиск
 * и переключатель вида справа.
 *
 * Фильтры здесь видимые, а не спрятанные за кнопкой: срез и человек меняются чаще
 * всего, и на телефоне ряд просто переносится. Вид на узком экране занимает одну
 * кнопку на значок, поэтому места хватает.
 */

export interface ToolbarView {
  value: string;
  onChange: (value: string) => void;
  options: SegmentOption[];
  /** Подпись для скринридера — визуально переключатель не подписан. */
  ariaLabel: string;
}

export function FilterToolbar({
  filters,
  view,
  search,
  className,
}: {
  /** Готовые контролы: `Segmented`, `PeopleFilter`, `Select`. */
  filters?: ReactNode;
  view?: ToolbarView;
  /** Обычно `SearchField`. */
  search?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-5 flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {filters}
      {/* Без нулевой основы: блок, который не влезает рядом со срезом, должен уйти на свою
          строку, а не сжаться и лечь на него. */}
      <div className="ml-auto flex min-w-0 items-center justify-end gap-2 max-sm:grow">
        {search}
        {view && (
          <Segmented
            value={view.value}
            onChange={view.onChange}
            options={view.options}
            ariaLabel={view.ariaLabel}
          />
        )}
      </div>
    </div>
  );
}
