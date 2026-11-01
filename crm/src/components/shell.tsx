import {
  Briefcase,
  Building2,
  CheckSquare,
  ExternalLink,
  KeyRound,
  Receipt,
  Globe,
  Images,
  Inbox,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useAuth, useCurrentUser } from "@/auth/auth-context";
import { GlobalSearch } from "@/components/global-search";
import { ScreenBoundary } from "@/components/screen-boundary";
import { cn } from "@/lib/cn";

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
    to: "/projects",
    label: "Проекты",
    icon: Briefcase,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
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
  // Корзина последняя: заходят туда редко и по конкретному поводу.
  {
    to: "/trash",
    label: "Корзина",
    icon: Trash2,
    end: false,
    leadsOnly: false,
    marketingOnly: false,
  },
] as const;

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
const itemClass = "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium";
const idleClass = "text-muted-foreground hover:bg-muted hover:text-foreground";
const activeClass = "bg-accent-soft text-foreground";

/**
 * Разделы и внешние ссылки. Вынесены из `Shell`, потому что рисуются дважды —
 * в боковой колонке и в выдвижной панели, — а разъехавшийся между ними список
 * это ровно тот баг, который замечают последним.
 */
function NavItems({ leadsOnly }: { leadsOnly: boolean }) {
  return (
    <>
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
            <Icon size={16} strokeWidth={2} />
            {label}
          </NavLink>
        ),
      )}

      <div className="border-border mt-4 border-t pt-4" />

      {EXTERNAL.filter((item) => !leadsOnly || item.leadsOnly).map(
        ({ href, label, icon: Icon }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noreferrer"
            className={cn(itemClass, idleClass, "group transition")}
          >
            <Icon size={16} strokeWidth={2} />
            {label}
            <ExternalLink
              size={13}
              strokeWidth={2}
              className="ml-auto opacity-0 transition-opacity group-hover:opacity-60"
            />
          </a>
        ),
      )}
    </>
  );
}

/** Низ панели: свои настройки и выход. Тоже общий для двух раскладок. */
function AccountItems({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <>
      <NavLink
        to="/settings"
        className={({ isActive }) =>
          cn(itemClass, "transition", isActive ? activeClass : idleClass)
        }
      >
        <Settings size={16} strokeWidth={2} />
        <span className="truncate">{name}</span>
      </NavLink>
      <button
        type="button"
        onClick={onLogout}
        className={cn(itemClass, idleClass, "w-full transition")}
      >
        <LogOut size={16} strokeWidth={2} />
        Выйти
      </button>
    </>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span className="bg-accent h-2 w-2 rounded-full" />
      <span className="text-sm font-bold tracking-tight">CRM</span>
    </span>
  );
}

/** Заголовок верхней полосы — чтобы на телефоне было видно, где ты стоишь. */
function useSectionTitle(): string {
  const { pathname } = useLocation();
  if (pathname === "/settings") return "Настройки";
  const match = NAV.filter((item) => item.to !== "/").find((item) =>
    pathname.startsWith(item.to),
  );
  return match?.label ?? NAV[0].label;
}

export function Shell() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const leadsOnly = user.role === "marketing";
  const { pathname } = useLocation();
  const title = useSectionTitle();
  /*
   * Не закрывается: 2FA не принудительная, чтобы никого не запереть, и это
   * единственное, что о ней напоминает. Маркетологу Доступы закрыты, текст был бы
   * неправдой, а на самих Настройках он только мешал бы.
   */
  const suggestTwoFactor =
    user.twoFactorAvailable &&
    !user.twoFactorEnabled &&
    !leadsOnly &&
    pathname !== "/settings";

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
          половину ширины, поэтому там её заменяет выдвижная панель. */}
      <aside className="border-border hidden shrink-0 border-r md:flex md:h-full md:w-56 md:flex-col md:px-3 md:py-5">
        <div className="px-2 pb-5">
          <Wordmark />
        </div>

        {!leadsOnly && (
          <div className="mb-3">
            <GlobalSearch />
          </div>
        )}

        {/* Прокручиваются только ссылки. Задать прокрутку всей колонке нельзя:
            она обрезала бы выпадающий список поиска, который стоит выше. */}
        <nav aria-label="Разделы" className="min-h-0 flex-1 overflow-y-auto">
          <NavItems leadsOnly={leadsOnly} />
        </nav>

        <div className="border-border mt-4 flex flex-col border-t pt-4">
          <AccountItems name={user.name ?? user.email} onLogout={() => void logout()} />
        </div>
      </aside>

      {/* Верхняя полоса телефона: кнопка меню, название раздела и поиск. */}
      <header className="border-border shrink-0 border-b md:hidden">
        <div className="flex items-center gap-1 px-2 py-2">
          <button
            ref={burger}
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Открыть меню разделов"
            aria-expanded={menuOpen}
            aria-controls="crm-menu"
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg p-2 transition"
          >
            <Menu size={20} strokeWidth={2} />
          </button>

          <span className="truncate px-1 text-sm font-bold tracking-tight">{title}</span>

          {!leadsOnly && (
            <button
              type="button"
              onClick={() => setSearchOpen((value) => !value)}
              aria-label={searchOpen ? "Скрыть поиск" : "Искать"}
              aria-expanded={searchOpen}
              className={cn(
                "ml-auto rounded-lg p-2 transition",
                searchOpen
                  ? "bg-accent-soft text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Search size={18} strokeWidth={2} />
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
          "border-border bg-background fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r px-3 py-4 shadow-xl",
          "transition-transform duration-300 ease-out will-change-transform motion-reduce:transition-none md:hidden",
          menuOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center justify-between px-2 pb-4">
          <Wordmark />
          <button
            ref={closeButton}
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Закрыть меню"
            className="text-muted-foreground hover:bg-muted hover:text-foreground -mr-1 rounded-lg p-1.5 transition"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavItems leadsOnly={leadsOnly} />
        </div>

        <div className="border-border mt-4 flex flex-col border-t pt-4">
          <AccountItems name={user.name ?? user.email} onLogout={() => void logout()} />
        </div>
      </nav>

      <main
        ref={main}
        className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5 sm:py-6 md:px-8 md:py-8"
      >
        {suggestTwoFactor && (
          <Link
            to="/settings"
            className="bg-warning-soft text-warning mb-5 flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition hover:opacity-80"
          >
            <ShieldAlert size={16} strokeWidth={2} className="shrink-0" />
            Включите двухфакторный вход: без него пароли в Доступах не открываются
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
      </main>
    </div>
  );
}
