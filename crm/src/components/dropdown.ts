import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Механика всплывающего списка: куда поставить, когда закрыть, как дать доиграть
 * затуханию. Общая у выбора из списка, выбора людей и выбора даты.
 *
 * Панель выводится порталом в body, поэтому координаты считаются здесь. Иначе её
 * обрезало бы модальное окно с `overflow-y-auto`. Отсюда же закрытие при прокрутке:
 * позиция считается один раз при открытии и за уехавшей кнопкой не следует.
 */

export interface DropdownBox {
  /** Либо `top`, либо `bottom`: вверх панель привязана низом, высота заранее неизвестна. */
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  /** Сколько есть до края экрана: панель прокручивается внутри, а не обрезается. */
  maxHeight: number;
}

export function useDropdown<T extends HTMLElement>(
  options: { panelWidth?: number; panelHeight?: number } = {},
) {
  const { panelWidth, panelHeight = 160 } = options;
  const [open, setOpen] = useState(false);
  /** Панель живёт чуть дольше, чем открыта: закрытие рисуется затуханием. */
  const [present, setPresent] = useState(false);
  const [box, setBox] = useState<DropdownBox | null>(null);
  const trigger = useRef<T>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;

    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    // Вверх, только когда снизу тесно и сверху просторнее: иначе панель прыгала бы
    // при каждом открытии у нижней трети экрана.
    const flip = below < panelHeight && above > below;

    const width = Math.min(Math.max(panelWidth ?? 0, rect.width), window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));

    const maxHeight = Math.max(160, (flip ? above : below) - 14);

    setBox(
      flip
        ? { bottom: window.innerHeight - rect.top + 6, left, width, maxHeight }
        : { top: rect.bottom + 6, left, width, maxHeight },
    );
  }, [open, panelWidth, panelHeight]);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = setTimeout(() => setPresent(false), 120);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onDown(event: MouseEvent) {
      const target = event.target as Element;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      // Клик по затемнению закрывает только панель. Иначе окно закрылось бы вместе с
      // заполненной формой: список людей остаётся открытым и закрывается кликом мимо.
      if (target.hasAttribute?.("data-modal-backdrop")) event.stopPropagation();
    }
    /**
     * Прокрутка страницы уносит кнопку, а панель осталась бы висеть. Прокрутка внутри
     * самой панели — ровно то, ради чего она открыта, и её надо отсеять: слушатель в
     * фазе перехвата ловит вообще любую.
     */
    function onScroll(event: Event) {
      // Цель бывает и окном браузера, а `contains` принимает только узел.
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      setOpen(false);
    }

    /**
     * Escape закрывает панель, а не окно, в котором она стоит. Ловим на входе в
     * документ: фокус может быть где угодно (на пункте списка, а Safari вообще не
     * ставит его на нажатую кнопку), и слушатель на кнопке срабатывал бы через раз,
     * а окно закрывалось бы вместе с заполненной формой.
     */
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }

    // В фазе перехвата: раньше обработчика окна, которое закрывается по тому же нажатию.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return { open, setOpen, present, box, trigger, panel };
}

/** Оформление панели одно на все списки. */
export const panelClass =
  "bg-popover shadow-float fixed z-[60] overflow-y-auto overscroll-contain rounded-2xl";
