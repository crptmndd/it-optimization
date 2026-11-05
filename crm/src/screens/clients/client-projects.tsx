import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import { columnOf, useColumns } from "@/api/columns";
import {
  listProjects,
  PROJECT_STATUS_LABELS,
  updateProject,
  type Project,
} from "@/api/projects";
import { Badge, Button, ErrorNote, LoadingRows, Select } from "@/components/ui";
import { paymentSummary } from "@/screens/projects/payment-summary";

/**
 * Проекты клиента прямо в его карточке: что с ним делается и что с оплатой, а
 * заодно привязка уже заведённых проектов и перенос от другого клиента.
 *
 * Новых маршрутов не нужно: привязка — обычный PATCH проекта с одним `clientId`,
 * остальные поля при этом не трогаются. Счета остаются у проекта и в «Счетах»
 * показываются с новым клиентом: история платежей идёт через проект.
 *
 * Все кнопки `type="button"`: снаружи форма клиента, и submit сохранил бы её.
 */

/** Сначала проекты без клиента: это и есть очередь на привязку. */
function byQueue(a: Project, b: Project): number {
  if (!a.client !== !b.client) return a.client ? 1 : -1;
  return a.title.localeCompare(b.title, "ru");
}

function optionLabel(project: Project): string {
  return [
    project.title,
    project.archivedAt ? "архив" : null,
    project.client ? `сейчас: ${project.client.name}` : "без клиента",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ClientProjects({
  clientId,
  clientName,
  onChanged,
}: {
  clientId: string;
  clientName: string;
  /** Привязка поменяла счётчики в списке клиентов. */
  onChanged: () => void;
}) {
  const [own, setOwn] = useState<Project[] | null>(null);
  const columns = useColumns("project");
  const [others, setOthers] = useState<Project[]>([]);
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const [mine, all] = await Promise.all([
      listProjects({ clientId, archived: "include" }),
      listProjects({ archived: "include" }),
    ]);
    setOwn(mine);
    setOthers(all.filter((project) => project.client?.id !== clientId).sort(byQueue));
  }, [clientId]);

  useEffect(() => {
    load().catch((cause: unknown) => {
      setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
      setOwn([]);
    });
  }, [load]);

  async function assign(project: Project, nextClientId: string | null) {
    setError(null);
    setPending(true);
    try {
      await updateProject(project.id, { clientId: nextClientId });
      setPicked("");
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
    } finally {
      setPending(false);
    }
  }

  function attach() {
    const project = others.find((item) => item.id === picked);
    if (!project) return;
    // Это уже не привязка, а перенос: проект уходит от другого клиента.
    if (
      project.client &&
      !confirm(
        `Перенести проект «${project.title}» от клиента «${project.client.name}» к клиенту «${clientName}»?`,
      )
    ) {
      return;
    }
    void assign(project, clientId);
  }

  return (
    <div className="mt-5">
      <h3 className="text-[15px] font-bold tracking-tight">Проекты</h3>

      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-1">
        {own === null ? (
          <LoadingRows rows={2} />
        ) : own.length === 0 ? (
          <p className="text-muted-foreground py-1 text-sm">Пока ни одного.</p>
        ) : (
          <ul className="divide-border divide-y">
            {own.map((project) => {
              const payment = paymentSummary(project);
              return (
                <li key={project.id} className="flex min-h-12 items-center gap-3 py-1.5">
                  {/* На компьютере всё в одну линию. На телефоне бейджи уходят вниз:
                      «этапы 1/3 · следующий 200 000 ₽» рядом с названием не влезает. */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <Link
                      to={`/projects?open=${project.id}`}
                      className="min-w-0 truncate text-sm font-semibold underline-offset-2 hover:underline sm:flex-1"
                    >
                      {project.title}
                    </Link>
                    <span className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                      <Badge>
                        {(columns && columnOf(columns, project)?.title) ??
                          PROJECT_STATUS_LABELS[project.status]}
                      </Badge>
                      {payment && <Badge tone={payment.tone}>{payment.label}</Badge>}
                      {project.archivedAt && <Badge>архив</Badge>}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => void assign(project, null)}
                  >
                    Отвязать
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {others.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select
              value={picked}
              onChange={setPicked}
              ariaLabel="Привязать проект"
              options={[
                { value: "", label: "Привязать проект" },
                ...others.map((project) => ({
                  value: project.id,
                  label: optionLabel(project),
                })),
              ]}
            />
          </div>
          {/* Не лаймовая: главное действие окна одно, и это «Сохранить». */}
          <Button
            type="button"
            variant="secondary"
            disabled={pending || !picked}
            onClick={attach}
          >
            Привязать
          </Button>
        </div>
      )}
    </div>
  );
}
