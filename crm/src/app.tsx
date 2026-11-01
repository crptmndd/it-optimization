import { HashRouter, Navigate, Route, Routes } from "react-router";
import { Shell } from "@/components/shell";
import { AuthProvider, useAuth } from "@/auth/auth-context";
import { ClientsScreen } from "@/screens/clients/clients-screen";
import { CredentialsScreen } from "@/screens/credentials/credentials-screen";
import { LeadsScreen } from "@/screens/leads/leads-screen";
import { InvoicesScreen } from "@/screens/invoices/invoices-screen";
import { LoginScreen } from "@/screens/login";
import { ProjectsScreen } from "@/screens/projects/projects-screen";
import { SettingsScreen } from "@/screens/settings";
import { TasksScreen } from "@/screens/tasks/tasks-screen";
import { TodayScreen } from "@/screens/today/today-screen";
import { TrashScreen } from "@/screens/trash/trash-screen";

function Routed() {
  const { state } = useAuth();

  if (state.status === "loading") {
    return (
      <div className="flex min-h-full items-center justify-center">
        <span className="text-muted-foreground text-sm">Загружаем…</span>
      </div>
    );
  }

  if (state.status === "anonymous") return <LoginScreen />;

  // Маркетолог ведёт только лиды, и только ему они и нужны: команда раздела не
  // видит. Маршруты остальных разделов ему просто не существуют — при попытке
  // зайти по адресу он окажется на лидах. Настоящий запрет при этом стоит на
  // сервере: сюда он бы всё равно упёрся в 403.
  if (state.user.role === "marketing") {
    return (
      <Routes>
        <Route element={<Shell />}>
          <Route path="leads" element={<LeadsScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="*" element={<Navigate to="/leads" replace />} />
        </Route>
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<TodayScreen />} />
        <Route path="projects" element={<ProjectsScreen />} />
        <Route path="tasks" element={<TasksScreen />} />
        <Route path="clients" element={<ClientsScreen />} />
        <Route path="invoices" element={<InvoicesScreen />} />
        {/* Старый адрес раздела: он остался в закладках. */}
        <Route path="money" element={<Navigate to="/invoices" replace />} />
        <Route path="credentials" element={<CredentialsScreen />} />
        <Route path="trash" element={<TrashScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        {/* Неизвестный адрес — не ошибка, а промах: возвращаем на главную. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/**
 * Маршрутизация через решётку: адреса выглядят как `/#/leads`.
 *
 * Выглядит старомодно, но не зависит от веб-сервера вообще. На шаред-хостинге
 * reg.ru PHP для аккаунта отключён, поэтому сайт отдаётся напрямую nginx, а он
 * не читает `.htaccess` — правило SPA-маршрутизации из `public/.htaccess` не
 * применяется, и прямая ссылка на `/leads` возвращает 404 от сервера. Всё, что
 * после решётки, на сервер не уходит совсем: он всегда отдаёт index.html.
 *
 * Если хостинг однажды научится отдавать index.html на любой путь (через
 * `try_files` в nginx или включённый Apache), достаточно вернуть здесь
 * BrowserRouter — больше ничего в коде не изменится.
 */
export function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </HashRouter>
  );
}
