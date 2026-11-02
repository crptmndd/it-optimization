import {
  Briefcase,
  Building2,
  CheckSquare,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Receipt,
  Globe,
  Images,
  Inbox,
  LogOut,
  Menu,
  Search,
  ShieldAlert,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useAuth, useCurrentUser } from "@/auth/auth-context";
import { GlobalSearch } from "@/components/global-search";
import { PersonChip } from "@/components/person-chip";
import { ScreenBoundary } from "@/components/screen-boundary";
import { cn } from "@/lib/cn";
import logoMark from "@/assets/logo-mark.svg";

/**
 * `leadsOnly` — пункты, доступные маркетологу. Остальные он не увидит, но
 * настоящий запрет стоит на сервере: скрытая кнопка защищает от случайного
 * клика, а не от человека, который наберёт адрес руками.
 *
 * `marketingOnly` — только ему: команда лидами больше не занимается, поэтому
 * пункт остаётся в списке (из него строится заголовок раздела), но ей не виден.
 */
const NAV = [
  {
    to: "/",
    label: "Сегодня",
    icon: Sun,
    end: true,
    leadsOnly: false,
    marketingOnly: false,
  },
  {
    to: "/leads",
    label: "Лиды",
    icon: Inbox,
    end: false,
    leadsOnly: true,
    marketingOnly: true,
  },
  {
    to: "/tasks",
    label: "Задачи",
    icon: CheckSquare,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
  {
    to: "/projects",
    label: "Проекты",
    icon: Briefcase,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
  {
    to: "/clients",
    label: "Клиенты",
    icon: Building2,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
  {
    to: "/invoices",
    label: "Счета",
    icon: Receipt,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
  {
    to: "/credentials",
    label: "Доступы",
    icon: KeyRound,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
] as const;

/** Нижняя панель телефона: то, что открывают каждый день. Остальное в «Ещё». */
const TAB_BAR = ["/", "/tasks", "/projects", "/invoices"] as const;

/**
 * Адрес сайта настраиваемый: локально удобно уводить на localhost:3000, а не
 * на боевой домен.
 */
const SITE_URL = (import.meta.env.VITE_SITE_URL ?? "https://it-optimization.ru").replace(
  /\/$/,
  "",
);

/**
 * Ссылки наружу. Вход общий, поэтому панель кейсов открывается без повторной
 * авторизации — кука выписана на весь домен. Маркетологу она не показывается:
 * API кейсов ему всё равно отвечает 403, и ссылка вела бы в пустую страницу с
 * ошибкой.
 */
const EXTERNAL = [
  { href: `${SITE_URL}/`, label: "Сайт", icon: Globe, leadsOnly: true },
  { href: `${SITE_URL}/panel/`, label: "Кейсы и блог", icon: Images, leadsOnly: false },
] as const;

/** Одна раскладка пункта на оба места: боковую колонку и выдвижную панель. */
const itemClass = "flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-semibold";
const idleClass = "text-muted-foreground hover:bg-black/[0.05] hover:text-foreground";
/* Чёрная плашка с лаймом — фирменное сочетание сайта и единственный тёмный акцент. */
const activeClass = "bg-surface text-surface-foreground [&>svg]:text-accent";
const smallItemClass =
  "flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium";

/**
 * Разделы. Вынесены из `Shell`, потому что рисуются дважды — в боковой колонке и в
 * выдвижной панели, — а разъехавшийся между ними список это ровно тот баг, который
 * замечают последним.
 */
function NavItems({ leadsOnly }: { leadsOnly: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {NAV.filter((item) => (leadsOnly ? item.leadsOnly : !item.marketingOnly)).map(
        ({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(itemClass, "transition", isActive ? activeClass : idleClass)
            }
          >
            <Icon size={18} strokeWidth={2.25} />
            {label}
          </NavLink>
        ),
      )}
    </div>
  );
}

/**
 * Редкое: корзина и ссылки наружу. Мельче и ниже разделов, иначе семь рабочих пунктов
 * тонули среди тех, куда заходят раз в месяц.
 */
function SecondaryItems({ leadsOnly }: { leadsOnly: boolean }) {
  return (
    <div className="flex flex-col">
      {!leadsOnly && (
        <NavLink
          to="/trash"
          className={({ isActive }) =>
            cn(
              smallItemClass,
              "transition",
              isActive
                ? "text-foreground bg-black/[0.05]"
                : "text-muted-foreground hover:text-foreground",
            )
          }
        >
          <Trash2 size={15} strokeWidth={2.25} />
          Корзина
        </NavLink>
      )}
      {EXTERNAL.filter((item) => !leadsOnly || item.leadsOnly).map(
        ({ href, label, icon: Icon }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              smallItemClass,
              "text-muted-foreground hover:text-foreground group transition",
            )}
          >
            <Icon size={15} strokeWidth={2.25} />
            {label}
            <ExternalLink
              size={12}
              strokeWidth={2.25}
              className="ml-auto opacity-0 transition-opacity group-hover:opacity-60"
            />
          </a>
        ),
      )}
    </div>
  );
}

/** Низ панели: своя строка ведёт в настройки, рядом выход. Общая для двух раскладок. */
function AccountItems({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          cn(
            "flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 text-sm font-semibold transition",
            isActive ? "bg-black/[0.05]" : "hover:bg-black/[0.05]",
          )
        }
      >
        <PersonChip name={name} className="size-7 text-xs" />
        <span className="truncate">{name}</span>
      </NavLink>
      <button
        type="button"
        onClick={onLogout}
        aria-label="Выйти"
        title="Выйти"
        className="text-muted-foreground hover:text-foreground flex size-10 shrink-0 items-center justify-center rounded-xl transition hover:bg-black/[0.05]"
      >
        <LogOut size={17} strokeWidth={2.25} />
      </button>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <img src={logoMark} alt="" className="h-[22px] w-auto" />
      <span className="text-[15px] font-extrabold tracking-tight">Айти-Оптимизация</span>
    </span>
  );
}

export function Shell() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const leadsOnly = user.role === "marketing";
  const { pathname } = useLocation();
  /*
   * Только там, где без 2FA что-то не работает или откуда начинают день: на каждом
   * экране полоса съедала место над списком и переставала читаться. Не закрывается,
   * потому что 2FA не принудительная, чтобы никого не запереть, и это единственное,
   * что о ней напоминает. Маркетологу Доступы закрыты, текст был бы неправдой.
   */
  const suggestTwoFactor =
    user.twoFactorAvailable &&
    !user.twoFactorEnabled &&
    !leadsOnly &&
    (pathname === "/" || pathname === "/credentials");

  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const burger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  // Переход в другой раздел закрывает панель сам: на телефоне она перекрывает
  // весь экран, и оставить её открытой поверх только что выбранного раздела
  // означает заставить закрывать её вручную после каждого нажатия.
  useEffect(() => setMenuOpen(false), [pathname]);

  /*
   * Новый раздел начинается сверху. Прокрутка живёт внутри <main> и сама не
   * сбрасывается: без этого раздел, открытый из середины длинного списка,
   * показывался бы с середины и выглядел полупустым.
   *
   * `useLayoutEffect`, а не `useEffect`, и это как раз то, что дёргалось при
   * смене раздела: обычный эффект выполняется после отрисовки, поэтому новый
   * раздел успевал показаться прокрученным на позицию предыдущего и только
   * потом прыгал наверх. Здесь сброс происходит до кадра, и прыжка нет.
   */
  useLayoutEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Фокус ходит за панелью: открылась — уходит внутрь, закрылась — возвращается
  // на кнопку, с которой всё началось. Без этого клавиатура остаётся позади
  // открытой панели, а после закрытия — в начале документа.
  useEffect(() => {
    if (menuOpen) closeButton.current?.focus();
    else if (wasOpen.current) burger.current?.focus();
    wasOpen.current = menuOpen;
  }, [menuOpen]);

  return (
    /* h-full, а не min-h-full: страница целиком не прокручивается, прокрутка
       живёт внутри <main>. Иначе боковая колонка уезжала бы вверх вместе с
       содержимым, и до разделов приходилось бы возвращаться скроллом. */
    <div className="flex h-full flex-col overflow-hidden md:flex-row">
      {/* Боковая колонка — только с планшета. На телефоне она съедала бы
          половину ширины, поэтому там её заменяет нижняя панель. */}
      <aside className="hidden shrink-0 md:flex md:h-full md:w-60 md:flex-col md:px-3 md:py-5">
        <div className="px-2.5 pb-5">
          <Wordmark />
        </div>

        {!leadsOnly && (
          <div className="mb-4">
            <GlobalSearch />
          </div>
        )}

        {/* Прокручиваются только ссылки. Задать прокрутку всей колонке нельзя:
            она обрезала бы выпадающий список поиска, который стоит выше. */}
        <nav aria-label="Разделы" className="min-h-0 flex-1 overflow-y-auto">
          <NavItems leadsOnly={leadsOnly} />
        </nav>

        <SecondaryItems leadsOnly={leadsOnly} />
        <div className="border-border mt-3 border-t pt-3">
          <AccountItems name={user.name ?? user.email} onLogout={() => void logout()} />
        </div>
      </aside>

      {/* Верхняя полоса телефона: логотип и поиск. Название раздела здесь не нужно,
          оно крупно стоит в начале самого экрана и в нижней панели. */}
      <header className="shrink-0 md:hidden">
        <div className="flex h-13 items-center justify-between pr-2 pl-4">
          <Wordmark />

          {leadsOnly ? (
            // Нижней панели у маркетолога нет, а настройки и выход нужны и ему.
            <button
              ref={burger}
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Открыть меню разделов"
              aria-expanded={menuOpen}
              aria-controls="crm-menu"
              className="text-muted-foreground hover:text-foreground flex size-10 items-center justify-center rounded-xl transition"
            >
              <Menu size={20} strokeWidth={2.25} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen((value) => !value)}
              aria-label={searchOpen ? "Скрыть поиск" : "Искать"}
              aria-expanded={searchOpen}
              className={cn(
                "flex size-10 items-center justify-center rounded-xl transition",
                searchOpen
                  ? "text-foreground bg-black/[0.06]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Search size={19} strokeWidth={2.25} />
            </button>
          )}
        </div>

        {/* Поиск разворачивается второй строкой, а не ужимается в остаток
            первой: на 360 пикселях поле шириной с два слова бесполезно. */}
        {searchOpen && !leadsOnly && (
          <div className="px-3 pb-2">
            <GlobalSearch />
          </div>
        )}
      </header>

      {/* Подложка. Гасит содержимое под панелью и закрывает её по нажатию. */}
      <div
        aria-hidden="true"
        onClick={() => setMenuOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 ease-out motion-reduce:transition-none md:hidden",
          menuOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Выдвижная панель. Всегда в разметке — иначе анимировать нечего: у
          только что вставленного узла нет предыдущего положения, и он просто
          появляется на месте. `inert` при этом убирает её из-под клавиатуры и
          скринридера, пока она за краем экрана. */}
      <nav
        id="crm-menu"
        inert={!menuOpen}
        aria-label="Разделы"
        className={cn(
          "bg-canvas fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col px-3 py-4",
          "transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none md:hidden",
          // Тень только у открытой: у спрятанной она лежала полосой вдоль левого края.
          menuOpen ? "translate-x-0 shadow-xl" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-2 pb-4">
          <Wordmark />
          <button
            ref={closeButton}
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрыть меню"
            className="text-muted-foreground hover:text-foreground -mr-1 flex size-9 items-center justify-center rounded-lg transition hover:bg-black/[0.05]"
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavItems leadsOnly={leadsOnly} />
        </div>

        <SecondaryItems leadsOnly={leadsOnly} />
        <div className="border-border mt-3 border-t pt-3">
          <AccountItems name={user.name ?? user.email} onLogout={() => void logout()} />
        </div>
      </nav>

      {/* Ширина ограничена: дата на другом краю большого монитора от названия задачи
          уже не читается как одна строка. */}
      <main
        ref={main}
        className="min-w-0 flex-1 overflow-y-auto px-4 pt-2 pb-24 sm:px-5 md:px-8 md:py-7"
      >
        <div className="mx-auto w-full max-w-[1120px]">
          {suggestTwoFactor && (
            <Link
              to="/settings"
              className="bg-warning-soft text-warning mb-5 flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition hover:opacity-80"
            >
              <ShieldAlert size={17} strokeWidth={2.25} className="shrink-0" />
              <span className="min-w-0 flex-1">
                Включите двухфакторный вход: без него пароли в Доступах не открываются
              </span>
              <ChevronRight size={16} strokeWidth={2.5} className="shrink-0" />
            </Link>
          )}

          {/* key по пути, а не по всему адресу: `?open=<id>` из «Сегодня» и поиска
            меняет только параметр, и перемонтирование сбросило бы уже
            загруженный список ровно тогда, когда в нём надо открыть карточку. */}
          <div key={pathname} className="crm-rise-in">
            <ScreenBoundary>
              <Outlet />
            </ScreenBoundary>
          </div>
        </div>
      </main>

      {/* Нижняя панель телефона: большой палец дотягивается сюда, а до кнопки меню в
          верхнем углу нет. У маркетолога раздел один, ему панель не нужна. */}
      {!leadsOnly && (
        <nav
          aria-label="Основные разделы"
          className="bg-background shadow-card fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {NAV.filter((item) => (TAB_BAR as readonly string[]).includes(item.to)).map(
            ({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold",
                    isActive ? "text-foreground" : "text-muted-foreground",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cn(
                        "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                        isActive && "bg-accent",
                      )}
                    >
                      <Icon size={18} strokeWidth={2.25} />
                    </span>
                    {label}
                  </>
                )}
              </NavLink>
            ),
          )}
          <button
            ref={burger}
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Открыть меню разделов"
            aria-expanded={menuOpen}
            aria-controls="crm-menu"
            className="text-muted-foreground flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold"
          >
            <span className="flex h-7 w-11 items-center justify-center">
              <Menu size={18} strokeWidth={2.25} />
            </span>
            Ещё
          </button>
        </nav>
      )}
    </div>
  );
}
