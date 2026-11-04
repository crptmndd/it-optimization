import { useSyncExternalStore } from "react";

/**
 * Тема оформления.
 *
 * По умолчанию следует за системой и переключается вместе с ней, без перезагрузки.
 * Выбор в Настройках закрепляет светлую или тёмную поверх системы. Он хранится на
 * устройстве, а не в учётке: на телефоне вечером и на рабочем мониторе днём нужна
 * разная тема, а одна настройка на все устройства спорила бы с системой каждого.
 *
 * Тот же ключ и тот же выбор читает скрипт в index.html, который ставит тему до первой
 * отрисовки. Поменять ключ здесь значит поменять его и там.
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "crm.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Хранилище закрыто (приватный режим, запрет cookies): живём по системе.
  }
  return "system";
}

const media = window.matchMedia(DARK_QUERY);
let choice = readChoice();
const listeners = new Set<() => void>();

function resolve(value: ThemeChoice): "light" | "dark" {
  if (value === "system") return media.matches ? "dark" : "light";
  return value;
}

function apply() {
  const root = document.documentElement;
  const theme = resolve(choice);
  if (root.dataset.theme !== theme) {
    // Переходы выключаются на один кадр, иначе экран перекрашивается пятнами.
    root.classList.add("crm-theme-switching");
    root.dataset.theme = theme;
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("crm-theme-switching"));
  }
  // Полоса браузера на телефоне в цвет полотна, а не белая над тёмной страницей.
  const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim();
  if (canvas)
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", canvas);
}

function emit() {
  for (const listener of listeners) listener();
}

media.addEventListener("change", () => {
  if (choice === "system") apply();
});

// Выбор в одной вкладке сразу доходит до остальных.
window.addEventListener("storage", (event) => {
  if (event.key !== KEY && event.key !== null) return;
  choice = readChoice();
  apply();
  emit();
});

apply();

export function setThemeChoice(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Не сохранилось: тема всё равно сменится, но только до перезагрузки.
  }
  apply();
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}
