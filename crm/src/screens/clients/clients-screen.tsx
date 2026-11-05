import {
  Mail,
  MessageCircle,
  Phone,
  Plus,
  Send,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { useOpenFromSearch } from "@/lib/open-from-search";
import { NoteHint } from "@/components/note-hint";
import {
  CONTACT_TYPES,
  createClient,
  deleteClient,
  listClients,
  updateClient,
  type Client,
} from "@/api/clients";
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
} from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  ClientFields,
  clientToValues,
  emptyClientValues,
  valuesToClientInput,
  type ClientFormValues,
} from "./client-form";
import { ClientProjects } from "./client-projects";
import { contactHref } from "@/lib/contacts";

const CONTACT_LABELS = new Map<string, string>(
  CONTACT_TYPES.map((type) => [type.value, type.label]),
);

/** Значок вместо подписи: «Телефон: …» в колонке повторялось бы в каждой строке. */
const CONTACT_ICONS: Record<string, LucideIcon> = {
  phone: Phone,
  email: Mail,
  telegram: Send,
  whatsapp: MessageCircle,
};

export function ClientsScreen() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(() => {
    setError(null);
    listClients(debouncedSearch || undefined)
      .then(setClients)
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : "Не удалось загрузить");
        setClients([]);
      });
  }, [debouncedSearch]);

  useEffect(load, [load]); // Переход из глобального поиска: ?open=<id> открывает нужную карточку.
  useOpenFromSearch(clients, setEditing);

  return (
    <section>
      <PageHeader title="Клиенты">
        <Button onClick={() => setCreating(true)}>
          <Plus size={17} strokeWidth={2.5} />
          Новый клиент
        </Button>
      </PageHeader>

      <div className="mt-5 flex">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Поиск по названию, ИНН или заметкам"
          className="sm:w-80"
        />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-5">
        {clients === null ? (
          <LoadingRows />
        ) : clients.length === 0 ? (
          <EmptyState
            title={debouncedSearch ? "Ничего не нашлось" : "Пока пусто"}
            note={
              debouncedSearch
                ? "Попробуйте другой запрос."
                : "Клиент появляется тогда, когда с ним начинается работа, а не при первом письме."
            }
          />
        ) : (
          <List>
            {clients.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                onOpen={() => setEditing(client)}
              />
            ))}
          </List>
        )}
      </div>

      {creating && (
        <ClientModal
          title="Новый клиент"
          initial={emptyClientValues()}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await createClient(valuesToClientInput(values));
            setCreating(false);
            load();
          }}
        />
      )}

      {editing && (
        <ClientModal
          title="Клиент"
          client={editing}
          initial={clientToValues(editing)}
          onClose={() => setEditing(null)}
          onChanged={load}
          onSubmit={async (values) => {
            await updateClient(editing.id, valuesToClientInput(values));
            setEditing(null);
            load();
          }}
          onDelete={async () => {
            await deleteClient(editing.id);
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

/** Контакты столбиком: длинная почта рядом с телефоном в одну строку не помещается. */
function ClientContacts({ client, className }: { client: Client; className?: string }) {
  const contacts = client.contacts.slice(0, 2);

  return (
    <span
      className={cn("text-muted-foreground min-w-0 text-[13px] font-medium", className)}
    >
      {contacts.length === 0 && "контакты не заполнены"}
      {contacts.map((contact, index) => {
        const Icon = CONTACT_ICONS[contact.type] ?? UserRound;
        const label = CONTACT_LABELS.get(contact.type) ?? contact.type;
        const href = contactHref(contact.type, contact.value);
        const body = (
          <>
            <Icon size={15} strokeWidth={2.25} aria-label={label} className="shrink-0" />
            <span className="truncate">{contact.value}</span>
          </>
        );
        // Ссылка поверх строки, которая сама открывает карточку: поэтому `relative z-10`,
        // иначе нажатие ушло бы растянутой кнопке под ней.
        return href ? (
          <a
            key={index}
            href={href}
            title={`${label}: открыть`}
            {...(href.startsWith("http") && { target: "_blank", rel: "noreferrer" })}
            className="hover:text-foreground relative z-10 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded transition-colors hover:underline hover:underline-offset-2"
          >
            {body}
          </a>
        ) : (
          <span key={index} title={label} className="flex min-w-0 items-center gap-1.5">
            {body}
          </span>
        );
      })}
    </span>
  );
}

/**
 * Строка открывает карточку целиком, а контакты в ней — ссылки. Кнопка внутри ссылки
 * и ссылка внутри кнопки в HTML запрещены, поэтому кнопка стоит на названии и
 * растянута на всю строку через `after`, а ссылки лежат над ней.
 */
function ClientRow({ client, onOpen }: { client: Client; onOpen: () => void }) {
  return (
    <li className="hover:bg-muted/60 relative transition-colors">
      {/* Доли, а не rem: с боковой колонкой на 768px остаётся меньше 500px, и
          колонка контактов постоянной ширины съела бы название целиком. */}
      <div className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_6.5rem]">
        <span className="min-w-0">
          <button
            type="button"
            onClick={onOpen}
            className="block max-w-full truncate text-left text-[15px] font-semibold after:absolute after:inset-0 after:content-['']"
          >
            {client.name}
          </button>
          <ClientContacts client={client} className="mt-0.5 block sm:hidden" />
          <NoteHint note={client.note} text={client.notes} />
        </span>

        <ClientContacts client={client} className="hidden sm:block" />

        <span className="flex justify-end">
          {client.projectCount > 0 && (
            <Badge tone={client.activeProjectCount > 0 ? "accent" : "neutral"}>
              {client.activeProjectCount > 0
                ? `${client.activeProjectCount} в работе`
                : `проектов ${client.projectCount}`}
            </Badge>
          )}
        </span>
      </div>
    </li>
  );
}

function ClientModal({
  title,
  client,
  initial,
  onClose,
  onChanged,
  onSubmit,
  onDelete,
}: {
  title: string;
  /** Есть только у сохранённого клиента: привязывать проект пока не к кому. */
  client?: Client;
  initial: ClientFormValues;
  onClose: () => void;
  /** Блок проектов сохранил своё без общей кнопки. */
  onChanged?: () => void;
  onSubmit: (values: ClientFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<ClientFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await onSubmit(values);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm("Удалить клиента?")) return;
    setError(null);
    setSaving(true);
    try {
      await onDelete();
    } catch (cause) {
      // Сервер отказывает, если у клиента есть проекты, — это осмысленный
      // ответ, и его текст объясняет, что делать.
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setSaving(false);
    }
  }

  return (
    // Шире только с проектами: их строкам нужно место под бейджи оплаты.
    <Modal title={title} onClose={onClose} wide={Boolean(client)}>
      <form onSubmit={handleSubmit}>
        <ClientFields values={values} onChange={setValues} />

        {client && (
          <ClientProjects
            clientId={client.id}
            clientName={client.name}
            onChanged={() => onChanged?.()}
          />
        )}

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-11 flex-1">
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="danger"
              className="h-11"
              onClick={() => void handleDelete()}
              disabled={saving}
            >
              Удалить
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
