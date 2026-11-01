import { Filter, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { FilterToolbar } from "@/components/filter-toolbar";
import { useFocusFromLink } from "@/lib/focus-card";
import { useOpenFromSearch } from "@/lib/open-from-search";
import {
  createLead,
  LEAD_CHANNELS,
  LEAD_STATUS_LABELS,
  listLeads,
  type Lead,
  type LeadFilters,
} from "@/api/leads";
import { listTeam, memberLabel, type TeamMember } from "@/api/team";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Modal,
  Select,
} from "@/components/ui";
import { useCurrentUser } from "@/auth/auth-context";
import { NoteHint } from "@/components/note-hint";
import { describeDeadline, formatDate } from "@/lib/dates";
import { serviceLabel } from "@/lib/services";
import { LeadDetail } from "./lead-detail";
import {
  emptyLeadValues,
  LeadFields,
  valuesToInput,
  type LeadFormValues,
} from "./lead-form";

/**
 * Срезы списка — от широкого к узкому. «Все» открывается по умолчанию: на
 * небольшом объёме честнее показать всё, что есть, чем прятать часть за
 * фильтром, о котором надо помнить. За просроченным следит не вкладка, а
 * утреннее сообщение бота.
 */
const TABS = [
  { key: "all", label: "Все", filters: { scope: "all" } },
  { key: "open", label: "Активные", filters: { scope: "open" } },
  { key: "overdue", label: "Просрочено", filters: { overdue: true } },
  { key: "closed", label: "Закрытые", filters: { scope: "closed" } },
] as const satisfies readonly { key: string; label: string; filters: LeadFilters }[];

type TabKey = (typeof TABS)[number]["key"];

// Map<string, …>, а не выведенный литеральный тип: в базе канал — свободная
// строка, и в неё может попасть значение, которого нет в списке.
const CHANNEL_LABELS = new Map<string, string>(
  LEAD_CHANNELS.map((item) => [item.value, item.label]),
);

export function LeadsScreen() {
  const currentUser = useCurrentUser();
  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);

  // Запрос уходит не на каждую букву: список перезагружается целиком, и без
  // паузы поиск из десяти символов даёт десять запросов подряд.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    const filters = TABS.find((item) => item.key === tab)?.filters ?? {};
    setError(null);
    listLeads({ ...filters, search: debouncedSearch || undefined })
      .then(setLeads)
      .catch((cause: unknown) =>
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить лиды"),
      );
  }, [tab, debouncedSearch]);

  useEffect(load, [load]); // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(leads, (lead) => setOpenLeadId(lead.id));
  useFocusFromLink(leads !== null);

  useEffect(() => {
    listTeam()
      .then(setTeam)
      .catch(() => setTeam([]));
  }, []);

  return (
    <section>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Лиды</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          Новый лид
        </Button>
      </header>

      {/* Вида у лидов нет — только срез и поиск, но панель та же. */}
      <FilterToolbar
        activeCount={tab === "all" ? 0 : 1}
        filters={[
          {
            label: "Срез",
            render: (full) => (
              <Select
                value={tab}
                onChange={(value) => setTab(value as TabKey)}
                ariaLabel="Фильтр лидов"
                icon={<Filter size={14} strokeWidth={2} />}
                className={full ? "w-full" : "w-40"}
                options={TABS.map((item) => ({ value: item.key, label: item.label }))}
              />
            ),
          },
        ]}
        search={
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по имени, контакту, тексту"
            className="w-full sm:w-72"
          />
        }
      />

      {error && (
        <div className="mt-6 sm:mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 sm:mt-5">
        {leads === null && !error && (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
        )}

        {leads?.length === 0 && (
          <EmptyState
            title={
              debouncedSearch
                ? "Ничего не нашлось"
                : tab === "overdue"
                  ? "Ничего не горит"
                  : "Пока пусто"
            }
            note={
              debouncedSearch
                ? "Попробуйте другой запрос."
                : tab === "overdue"
                  ? "Ни по одному лиду не просрочен следующий шаг."
                  : "Заведите первый лид — кнопка справа сверху."
            }
          />
        )}

        {leads && leads.length > 0 && (
          <ul className="space-y-3 sm:space-y-2">
            {leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onOpen={() => setOpenLeadId(lead.id)} />
            ))}
          </ul>
        )}
      </div>

      {creating && (
        <CreateLeadModal
          team={team}
          defaultOwnerId={currentUser.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      )}

      {openLeadId && (
        <LeadDetail
          leadId={openLeadId}
          team={team}
          onClose={() => setOpenLeadId(null)}
          onChanged={load}
        />
      )}
    </section>
  );
}

function LeadRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const deadline = lead.nextActionAt ? describeDeadline(lead.nextActionAt) : null;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-card-id={lead.id}
        className="border-border bg-background hover:border-accent-border flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-3 text-left transition hover:shadow-sm sm:py-2.5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{lead.name ?? lead.contact}</span>
          <span className="text-muted-foreground block truncate text-sm">
            {[
              lead.name ? lead.contact : null,
              serviceLabel(lead.service) || null,
              lead.channel ? (CHANNEL_LABELS.get(lead.channel) ?? lead.channel) : null,
              lead.message,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          {deadline && (
            // Действие впереди срока: в потоке взгляд цепляется за «позвонить»,
            // а не за «завтра». Ширина ограничена, иначе длинная подпись
            // разваливает строку списка.
            <Badge
              tone={
                deadline.tone === "danger"
                  ? "danger"
                  : deadline.tone === "warning"
                    ? "warning"
                    : "neutral"
              }
              className="block max-w-[14rem] truncate"
            >
              {lead.nextActionNote
                ? `${lead.nextActionNote} · ${deadline.label}`
                : deadline.label}
            </Badge>
          )}
          <Badge tone={lead.status === "won" ? "success" : "neutral"}>
            {LEAD_STATUS_LABELS[lead.status]}
          </Badge>
          <span className="text-muted-foreground hidden w-24 truncate text-right text-xs sm:block">
            {lead.owner ? memberLabel(lead.owner) : formatDate(lead.createdAt)}
          </span>
        </span>
        <NoteHint note={lead.note} />
      </button>
    </li>
  );
}

function CreateLeadModal({
  team,
  defaultOwnerId,
  onClose,
  onCreated,
}: {
  team: TeamMember[];
  defaultOwnerId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  // По умолчанию лид вешается на того, кто его завёл: ничей лид — первый
  // кандидат на то, чтобы про него забыли.
  const [values, setValues] = useState<LeadFormValues>(() =>
    emptyLeadValues(defaultOwnerId),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await createLead(valuesToInput(values));
      onCreated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  return (
    <Modal title="Новый лид" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <LeadFields values={values} onChange={setValues} team={team} />
        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}
        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Завести"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
