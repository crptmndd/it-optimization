import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./lib/theme";

const container = document.getElementById("root");
if (!container) throw new Error("Не найден #root");

/**
 * Импорт приложения отложен: `api/client.ts` падает при старте, если не задан
 * VITE_API_URL. Без перехвата это белый экран и ошибка в консоли — а так видно
 * текст прямо на странице.
 */
import("./app")
  .then(({ App }) => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((cause: unknown) => {
    container.innerHTML = "";
    const message = document.createElement("pre");
    message.style.cssText =
      "padding:2rem;font:14px/1.6 ui-monospace,monospace;white-space:pre-wrap;color:#dc2626";
    message.textContent = `Приложение не запустилось.\n\n${
      cause instanceof Error ? cause.message : String(cause)
    }`;
    container.append(message);
  });
