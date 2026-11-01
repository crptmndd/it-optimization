import { Plus } from "lucide-react";
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
import { Badge, Button, EmptyState, ErrorNote, Input, Modal } from "@/components/ui";
import {
  ClientFields,
  clientToValues,
  emptyClientValues,
  valuesToClientInput,
  type ClientFormValues,
} from "./client-form";
import { ClientProjects } from "./client-projects";

const CONTACT_LABELS = new Map<string, string>(
  CONTACT_TYPES.map((type) => [type.value, type.label]),
);

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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold tracking-tight">Клиенты</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} strokeWidth={2.5} />
          Новый клиент
        </Button>
      </header>

      <div className="mt-6 sm:mt-5">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Поиск по названию, ИНН или заметкам"
          className="w-full sm:w-80"
        />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <div className="mt-6 sm:mt-5">
        {clients === null ? (
          <p className="text-muted-foreground text-sm">Загружаем…</p>
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
          <ul className="space-y-3 sm:space-y-2">
            {clients.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                onOpen={() => setEditing(client)}
              />
            ))}
          </ul>
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

function ClientRow({ client, onOpen }: { client: Client; onOpen: () => void }) {
  const contacts = client.contacts
    .slice(0, 2)
    .map(
      (contact) =>
        `${CONTACT_LABELS.get(contact.type) ?? contact.type}: ${contact.value}`,
    )
    .join(" · ");

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="border-border bg-background hover:border-accent-border flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition hover:shadow-sm"
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{client.name}</span>
          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
            {contacts || "контакты не заполнены"}
          </span>
          <NoteHint note={client.note} text={client.notes} />
        </div>

        {client.projectCount > 0 && (
          <Badge
            tone={client.activeProjectCount > 0 ? "accent" : "neutral"}
            className="mt-0.5"
          >
            {client.activeProjectCount > 0
              ? `${client.activeProjectCount} в работе`
              : `проектов ${client.projectCount}`}
          </Badge>
        )}
      </button>
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
    <Modal title={title} onClose={onClose}>
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

        <div className="mt-5 flex items-center gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          {onDelete && (
            <Button
              type="button"
              variant="danger"
              className="ml-auto"
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
