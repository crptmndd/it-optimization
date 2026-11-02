import { Plus } from "lucide-react";
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
import { PersonChip } from "@/components/person-chip";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  List,
  LoadingRows,
  Modal,
  PageHeader,
  SearchField,
  Segmented,
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

function channelLabel(lead: Lead): string | null {
  return lead.channel ? (CHANNEL_LABELS.get(lead.channel) ?? lead.channel) : null;
}

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

  const overdueTab = tab === "overdue";

  return (
    <section>
      <PageHeader title="Лиды">
        <Button onClick={() => setCreating(true)}>
          <Plus size={17} strokeWidth={2.5} />
          Новый лид
        </Button>
      </PageHeader>

      <FilterToolbar
        filters={
          <Segmented
            value={tab}
            onChange={(value) => setTab(value as TabKey)}
            ariaLabel="Какие лиды показать"
            options={TABS.map((item) => ({ value: item.key, label: item.label }))}
          />
        }
        search={
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Имя, контакт, текст"
          />
        }
      />

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {leads === null && !error && <LoadingRows />}

        {leads?.length === 0 && (
          <EmptyState
            title={
              debouncedSearch
                ? "Ничего не нашлось"
                : overdueTab
                  ? "Ничего не горит"
                  : "Пока пусто"
            }
            note={
              debouncedSearch
                ? "Попробуйте другой запрос."
                : overdueTab
                  ? "Ни по одному лиду не просрочен следующий шаг."
                  : "Заведите первый лид — кнопка справа сверху."
            }
          />
        )}

        {leads && leads.length > 0 && (
          <List>
            {leads.map((lead) => (
              <LeadRow key={lead.id} lead={lead} onOpen={() => setOpenLeadId(lead.id)} />
            ))}
          </List>
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

/**
 * Колонки появляются с `lg`, а не с `sm`: на 768 уже стоит боковое меню и ширины меньше,
 * чем на телефоне с поворотом. Контакт и услуга получают свои колонки с `xl`, а до этого
 * едут одной строкой под именем: поставить их рядом там просто негде.
 */
function LeadRow({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const deadline = lead.nextActionAt ? describeDeadline(lead.nextActionAt) : null;
  const contact = lead.name ? lead.contact : null;
  const service = serviceLabel(lead.service) || null;
  const channel = channelLabel(lead);
  const details = [contact, service, channel, lead.message].filter(Boolean).join(" · ");

  return (
    <li data-card-id={lead.id} className="hover:bg-muted/60 transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left lg:grid-cols-[minmax(0,1fr)_11rem_6.5rem_5.5rem] xl:grid-cols-[minmax(0,1fr)_10rem_9rem_11rem_6.5rem_5.5rem]"
      >
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold">
            {lead.name ?? lead.contact}
          </span>
          {details && (
            <span className="text-muted-foreground block truncate text-[13px] font-medium xl:hidden">
              {details}
            </span>
          )}
          {lead.message && (
            <span className="text-muted-foreground hidden truncate text-[13px] font-medium xl:block">
              {lead.message}
            </span>
          )}
        </span>

        <span className="text-muted-foreground hidden truncate text-[13px] font-medium xl:block">
          {contact}
        </span>

        <span className="hidden min-w-0 xl:block">
          <span className="text-muted-foreground block truncate text-[13px] font-medium">
            {service}
          </span>
          <span className="text-muted-foreground block truncate text-xs font-medium">
            {channel}
          </span>
        </span>

        {/* Действие впереди срока: в потоке взгляд цепляется за «позвонить», а не за
            «завтра». Без даты шага в строке нет: напоминать не о чем. Пустая ячейка нужна
            только колонкам: на узком экране она дала бы пустую строку. */}
        <span className="flex min-w-0 items-center justify-between gap-2 max-lg:order-1 max-lg:col-span-full max-lg:empty:hidden lg:flex-col lg:items-start lg:justify-start lg:gap-0.5">
          {deadline && (
            <>
              {lead.nextActionNote && (
                <span className="max-w-full min-w-0 truncate text-[13px] font-semibold">
                  {lead.nextActionNote}
                </span>
              )}
              <Badge tone={deadline.tone} className="shrink-0">
                {deadline.label}
              </Badge>
            </>
          )}
        </span>

        {/* На узком экране статус и ответственный стоят столбиком справа от имени, а с
            `lg` через `contents` становятся своими колонками. */}
        <span className="flex flex-col-reverse items-end gap-1 lg:contents">
          <Badge
            tone={lead.status === "won" ? "success" : "neutral"}
            className="lg:justify-self-start"
          >
            {LEAD_STATUS_LABELS[lead.status]}
          </Badge>

          <span className="flex justify-end">
            {lead.owner ? (
              <PersonChip name={memberLabel(lead.owner)} />
            ) : (
              <span className="text-muted-foreground text-xs font-medium whitespace-nowrap">
                {formatDate(lead.createdAt)}
              </span>
            )}
          </span>
        </span>

        <NoteHint note={lead.note} className="col-span-full mt-0.5 max-lg:order-1" />
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
        <div className="mt-6">
          <Button type="submit" disabled={saving} className="h-11 w-full">
            {saving ? "Сохраняем…" : "Завести"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
