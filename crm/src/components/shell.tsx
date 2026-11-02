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
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldAlert,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { isAdmin, useAuth, useCurrentUser } from "@/auth/auth-context";
import { GlobalSearch } from "@/components/global-search";
import { PersonChip } from "@/components/person-chip";
import { ScreenBoundary } from "@/components/screen-boundary";
import { cn } from "@/lib/cn";
import logoMark from "@/assets/logo-mark.svg";

/**
 * `adminOnly` — разделов нет у сотрудника. Скрытая кнопка защищает от случайного клика, а
 * не от человека, который наберёт адрес руками: настоящий запрет стоит на сервере.
 */
const NAV = [
  { to: "/", label: "Сегодня", icon: Sun, end: true, adminOnly: false },
  { to: "/tasks", label: "Задачи", icon: CheckSquare, end: false, adminOnly: false },
  { to: "/projects", label: "Проекты", icon: Briefcase, end: false, adminOnly: false },
  { to: "/clients", label: "Клиенты", icon: Building2, end: false, adminOnly: true },
  { to: "/invoices", label: "Счета", icon: Receipt, end: false, adminOnly: true },
  { to: "/credentials", label: "Доступы", icon: KeyRound, end: false, adminOnly: true },
] as const;

/** Нижняя панель телефона: то, что открывают каждый день. Остальное в «Ещё». */
const TAB_BAR = ["/", "/tasks", "/projects", "/invoices"] as const;

/** Экраны с доской живут шириной окна, остальным нужен потолок: см. разметку `main`. */
const FULL_WIDTH = ["/tasks", "/projects"] as const;

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
 * авторизации — кука выписана на весь домен. Только у админа: сотруднику API кейсов
 * отвечает 403, и ссылка вела бы в пустую страницу с ошибкой.
 */
const EXTERNAL = [
  { href: `${SITE_URL}/`, label: "Сайт", icon: Globe },
  { href: `${SITE_URL}/panel/`, label: "Кейсы и блог", icon: Images },
] as const;

const COLLAPSED_KEY = "crm.sidebar.collapsed";

/** С этой ширины есть боковая колонка: ниже `md` сворачивать нечего. */
const DESKTOP = "(min-width: 768px)";

const IS_MAC = /mac/i.test(navigator.platform);

/** Хранилище бывает закрыто: панель тогда просто не запоминается. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Не запомнится до следующего входа, а работать это не мешает.
  }
}

/**
 * Значки стоят на месте и в раскрытой, и в свёрнутой колонке: левый отступ равен тому,
 * что центрирует их в свёрнутых 48 пикселях. Поэтому при сворачивании ничего не прыгает,
 * а подпись просто уходит под край пункта. Те же отступы держат подписи разделов и
 * нижних пунктов на одной вертикали.
 */
const itemClass =
  "flex h-10 items-center gap-3 overflow-hidden rounded-xl px-[15px] text-sm font-semibold whitespace-nowrap";
const idleClass = "text-muted-foreground hover:bg-black/[0.05] hover:text-foreground";
/* Чёрная плашка с лаймом — фирменное сочетание сайта и единственный тёмный акцент. */
const activeClass = "bg-surface text-surface-foreground [&>svg]:text-accent";
const smallItemClass =
  "flex h-8 items-center gap-[13px] overflow-hidden rounded-lg px-4 text-[13px] font-medium whitespace-nowrap";
/** Один темп на всё, что меняется при сворачивании: ширину, высоту блоков, подписи. */
const foldClass = "duration-200 ease-out motion-reduce:transition-none";

/**
 * Подпись гаснет, но остаётся в разметке: свёрнутая панель не теряет имена разделов для
 * скринридера и не перестраивает пункт.
 */
function FoldLabel({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <span className={cn("transition-opacity", foldClass, hidden && "opacity-0")}>
      {children}
    </span>
  );
}

/**
 * Разделы. Вынесены из `Shell`, потому что рисуются дважды — в боковой колонке и в
 * выдвижной панели, — а разъехавшийся между ними список это ровно тот баг, который
 * замечают последним.
 */
function NavItems({ admin, collapsed = false }: { admin: boolean; collapsed?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {NAV.filter((item) => admin || !item.adminOnly).map(
        ({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(itemClass, "transition", isActive ? activeClass : idleClass)
            }
          >
            <Icon size={18} strokeWidth={2.25} className="shrink-0" />
            <FoldLabel hidden={collapsed}>{label}</FoldLabel>
          </NavLink>
        ),
      )}
    </div>
  );
}

/**
 * Редкое: корзина и ссылки наружу. Мельче и ниже разделов, иначе рабочие пункты тонули
 * среди тех, куда заходят раз в месяц. У сотрудника этого нет совсем.
 */
function SecondaryItems({
  admin,
  collapsed = false,
}: {
  admin: boolean;
  collapsed?: boolean;
}) {
  if (!admin) return null;

  return (
    <div className="flex flex-col">
      <NavLink
        to="/trash"
        title={collapsed ? "Корзина" : undefined}
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
        <Trash2 size={16} strokeWidth={2.25} className="shrink-0" />
        <FoldLabel hidden={collapsed}>Корзина</FoldLabel>
      </NavLink>
      {EXTERNAL.map(({ href, label, icon: Icon }) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer"
          title={collapsed ? label : undefined}
          className={cn(
            smallItemClass,
            "text-muted-foreground hover:text-foreground group transition",
          )}
        >
          <Icon size={16} strokeWidth={2.25} className="shrink-0" />
          <FoldLabel hidden={collapsed}>{label}</FoldLabel>
          <ExternalLink
            size={12}
            strokeWidth={2.25}
            className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
          />
        </a>
      ))}
    </div>
  );
}

/**
 * Низ панели: своя строка ведёт в настройки, рядом выход. Общая для двух раскладок.
 * В свёрнутой колонке блок становится выше, а выход, привязанный к низу, съезжает под
 * кружок: и то и другое без смены раскладки, поэтому плавно.
 */
function AccountItems({
  name,
  onLogout,
  collapsed = false,
}: {
  name: string;
  onLogout: () => void;
  collapsed?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative transition-[height]",
        foldClass,
        collapsed ? "h-[5.5rem]" : "h-11",
      )}
    >
      <NavLink
        to="/settings"
        title={collapsed ? name : undefined}
        className={({ isActive }) =>
          cn(
            "flex h-11 w-full items-center gap-2.5 overflow-hidden rounded-xl pl-2.5 text-sm font-semibold transition",
            // Поле под кнопку выхода. В свёрнутой колонке она ниже, а поле раздуло бы
            // подложку шире колонки значков.
            !collapsed && "pr-11",
            isActive ? "bg-black/[0.05]" : "hover:bg-black/[0.05]",
          )
        }
      >
        <PersonChip name={name} className="size-7 text-xs" />
        <span
          className={cn(
            "truncate transition-opacity",
            foldClass,
            collapsed && "opacity-0",
          )}
        >
          {name}
        </span>
      </NavLink>
      <button
        type="button"
        onClick={onLogout}
        aria-label="Выйти"
        title="Выйти"
        className="text-muted-foreground hover:text-foreground absolute right-1 bottom-0.5 flex size-10 items-center justify-center rounded-xl transition hover:bg-black/[0.05]"
      >
        <LogOut size={17} strokeWidth={2.25} />
      </button>
    </div>
  );
}

function Wordmark({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <img src={logoMark} alt="" className="h-[22px] w-auto shrink-0" />
      <span
        className={cn(
          "text-[15px] font-extrabold tracking-tight whitespace-nowrap transition-opacity",
          foldClass,
          collapsed && "opacity-0",
        )}
      >
        Айти-Оптимизация
      </span>
    </span>
  );
}

export function Shell() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const admin = isAdmin(user);
  const { pathname } = useLocation();
  /*
   * Только там, где без 2FA что-то не работает или откуда начинают день: на каждом
   * экране полоса съедала место над списком и переставала читаться. Не закрывается,
   * потому что 2FA не принудительная, чтобы никого не запереть, и это единственное,
   * что о ней напоминает. Сотруднику Доступы закрыты, текст был бы неправдой.
   */
  const suggestTwoFactor =
    user.twoFactorAvailable &&
    !user.twoFactorEnabled &&
    admin &&
    (pathname === "/" || pathname === "/credentials");

  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Чтение прямо в начальном состоянии: иначе при каждой загрузке панель сворачивалась
  // бы на глазах из раскрытой.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  /** Значок поиска раскрывает панель, а поле появляется только после этого. */
  const focusSearch = useRef(false);
  const searchBox = useRef<HTMLDivElement>(null);
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

  useEffect(() => writeCollapsed(collapsed), [collapsed]);

  /*
   * `code`, а не `key`: в русской раскладке клавиша даёт «и», а сочетание должно
   * работать при любой. Срабатывает и в поле ввода: жирного в наших полях нет.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code !== "KeyB" || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!window.matchMedia(DESKTOP).matches) return;
      event.preventDefault();
      setCollapsed((current) => !current);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (collapsed || !focusSearch.current) return;
    focusSearch.current = false;
    searchBox.current?.querySelector("input")?.focus();
  }, [collapsed]);

  const collapseLabel = collapsed ? "Развернуть панель" : "Свернуть панель";
  const account = user.name ?? user.email;
  const tabs = NAV.filter(
    (item) =>
      (admin || !item.adminOnly) && (TAB_BAR as readonly string[]).includes(item.to),
  );

  return (
    /* h-full, а не min-h-full: страница целиком не прокручивается, прокрутка
       живёт внутри <main>. Иначе боковая колонка уезжала бы вверх вместе с
       содержимым, и до разделов приходилось бы возвращаться скроллом. */
    <div className="flex h-full flex-col overflow-hidden md:flex-row">
      {/* Боковая колонка — только с планшета. На телефоне она съедала бы
          половину ширины, поэтому там её заменяет нижняя панель. */}
      <aside
        className={cn(
          "hidden shrink-0 transition-[width] md:flex md:h-full md:flex-col md:px-3 md:pt-3 md:pb-5",
          foldClass,
          collapsed ? "md:w-[72px]" : "md:w-64",
        )}
      >
        {/* Кнопка привязана к правому нижнему углу шапки: в свёрнутой колонке шапка
            становится выше и уже, и кнопка сама встаёт под логотип. */}
        <div
          className={cn(
            "relative mb-3 shrink-0 transition-[height]",
            foldClass,
            collapsed ? "h-[5.25rem]" : "h-10",
          )}
        >
          <div className="flex h-10 items-center overflow-hidden pr-11 pl-2.5">
            <Wordmark collapsed={collapsed} />
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((current) => !current)}
            aria-label={collapseLabel}
            aria-expanded={!collapsed}
            title={`${collapseLabel} (${IS_MAC ? "⌘B" : "Ctrl+B"})`}
            className="text-muted-foreground hover:text-foreground absolute right-1 bottom-0 flex size-10 items-center justify-center rounded-xl transition hover:bg-black/[0.05]"
          >
            {collapsed ? (
              <PanelLeftOpen size={18} strokeWidth={2.25} />
            ) : (
              <PanelLeftClose size={18} strokeWidth={2.25} />
            )}
          </button>
        </div>

        <div ref={searchBox} className="mb-4 shrink-0">
          {collapsed ? (
            <button
              type="button"
              onClick={() => {
                focusSearch.current = true;
                setCollapsed(false);
              }}
              aria-label="Поиск по всей CRM"
              title="Поиск по CRM"
              className="bg-background shadow-card text-muted-foreground hover:text-foreground flex h-10 w-full items-center justify-center rounded-xl transition"
            >
              <Search size={16} strokeWidth={2.25} />
            </button>
          ) : (
            <GlobalSearch />
          )}
        </div>

        {/* Прокручиваются только ссылки. Задать прокрутку всей колонке нельзя:
            она обрезала бы выпадающий список поиска, который стоит выше. */}
        <nav aria-label="Разделы" className="min-h-0 flex-1 overflow-y-auto">
          <NavItems admin={admin} collapsed={collapsed} />
        </nav>

        <SecondaryItems admin={admin} collapsed={collapsed} />
        <div className="border-border mt-3 border-t pt-3">
          <AccountItems
            name={account}
            onLogout={() => void logout()}
            collapsed={collapsed}
          />
        </div>
      </aside>

      {/* Верхняя полоса телефона: логотип и поиск. Название раздела здесь не нужно,
          оно крупно стоит в начале самого экрана и в нижней панели. */}
      <header className="shrink-0 md:hidden">
        <div className="flex h-13 items-center justify-between pr-2 pl-4">
          <Wordmark />

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
        </div>

        {/* Поиск разворачивается второй строкой, а не ужимается в остаток
            первой: на 360 пикселях поле шириной с два слова бесполезно. */}
        {searchOpen && (
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
          <NavItems admin={admin} />
        </div>

        <SecondaryItems admin={admin} />
        <div className="border-border mt-3 border-t pt-3">
          <AccountItems name={account} onLogout={() => void logout()} />
        </div>
      </nav>

      {/* Ширина ограничена: дата на другом краю большого монитора от названия задачи
          уже не читается как одна строка. Экраны с доской без потолка: колонкам нужен
          весь монитор, иначе половина экрана стоит пустой. */}
      <main
        ref={main}
        className="min-w-0 flex-1 overflow-y-auto px-4 pt-2 pb-24 sm:px-5 md:px-8 md:py-7"
      >
        <div
          className={cn(
            "mx-auto w-full",
            (FULL_WIDTH as readonly string[]).includes(pathname)
              ? "max-w-none"
              : "max-w-[1280px]",
          )}
        >
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
          верхнем углу нет. «Ещё» есть у всех: настройки и выход живут там. */}
      <nav
        aria-label="Основные разделы"
        className={cn(
          "bg-background shadow-card fixed inset-x-0 bottom-0 z-30 grid pb-[env(safe-area-inset-bottom)] md:hidden",
          admin ? "grid-cols-5" : "grid-cols-4",
        )}
      >
        {tabs.map(({ to, label, icon: Icon, end }) => (
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
        ))}
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
    </div>
  );
}
