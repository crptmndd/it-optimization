import { Plus, X } from "lucide-react";
import { useState } from "react";
import {
  CONTACT_TYPES,
  type Client,
  type ClientContact,
  type ClientInput,
} from "@/api/clients";
import { Field, Input, Select, Textarea } from "@/components/ui";

export interface ClientFormValues {
  name: string;
  inn: string;
  site: string;
  contacts: ClientContact[];
  notes: string;
}

export function emptyClientValues(): ClientFormValues {
  return { name: "", inn: "", site: "", contacts: [], notes: "" };
}

export function clientToValues(client: Client): ClientFormValues {
  return {
    name: client.name,
    inn: client.inn ?? "",
    site: client.site ?? "",
    contacts: client.contacts.map((contact) => ({ ...contact })),
    notes: client.notes ?? "",
  };
}

export function valuesToClientInput(values: ClientFormValues): ClientInput {
  return {
    name: values.name.trim(),
    inn: values.inn.trim() || null,
    site: values.site.trim() || null,
    // Пустые строки отсеиваем здесь: сервер их отвергнет, а человек не поймёт,
    // какая именно из пяти строк контакта пустая.
    contacts: values.contacts.filter((contact) => contact.value.trim() !== ""),
    notes: values.notes.trim() || null,
  };
}

export function ClientFields({
  values,
  onChange,
}: {
  values: ClientFormValues;
  onChange: (values: ClientFormValues) => void;
}) {
  // Заметки нужны не каждому клиенту: пустое поле только удлиняло окно.
  const [notesOpen, setNotesOpen] = useState(values.notes !== "");

  function set<K extends keyof ClientFormValues>(key: K, value: ClientFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  function setContact(index: number, patch: Partial<ClientContact>) {
    set(
      "contacts",
      values.contacts.map((contact, current) =>
        current === index ? { ...contact, ...patch } : contact,
      ),
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <Field label="Название">
          <Input
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            required
            autoFocus
            maxLength={200}
            placeholder="ООО «Ромашка» · Иван Петров"
            className="h-12 text-base font-semibold"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ИНН">
            <Input
              value={values.inn}
              onChange={(event) => set("inn", event.target.value)}
              maxLength={20}
              inputMode="numeric"
            />
          </Field>

          <Field label="Сайт">
            <Input
              value={values.site}
              onChange={(event) => set("site", event.target.value)}
              maxLength={200}
              placeholder="example.ru"
            />
          </Field>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-[15px] font-bold tracking-tight">Контакты</h3>
        <div className="space-y-2 empty:hidden">
          {values.contacts.map((contact, index) => (
            <div key={index} className="flex items-center gap-2">
              <Select
                value={contact.type}
                onChange={(type) => setContact(index, { type })}
                options={CONTACT_TYPES.map((type) => ({
                  value: type.value,
                  label: type.label,
                }))}
                className="w-32 shrink-0"
              />
              <Input
                value={contact.value}
                onChange={(event) => setContact(index, { value: event.target.value })}
                maxLength={200}
                placeholder="+7 999 000-00-00"
              />
              <button
                type="button"
                onClick={() =>
                  set(
                    "contacts",
                    values.contacts.filter((_, current) => current !== index),
                  )
                }
                aria-label="Убрать контакт"
                className="text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 rounded-lg p-2 transition"
              >
                <X size={16} strokeWidth={2.25} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            set("contacts", [...values.contacts, { type: "phone", value: "" }])
          }
          className="text-muted-foreground hover:text-foreground mt-2.5 flex items-center gap-1.5 text-[13px] font-semibold transition"
        >
          <Plus size={15} strokeWidth={2.5} />
          Добавить контакт
        </button>
      </div>

      {notesOpen ? (
        <Field label="Заметки">
          {/* Пустое поле открыли нажатием, и печатать будут сразу. У клиента с
              заметками оно открыто с начала, и фокус остаётся на названии. */}
          <Textarea
            value={values.notes}
            onChange={(event) => set("notes", event.target.value)}
            rows={3}
            autoFocus={values.notes === ""}
            placeholder="Как платят, кто принимает решения, чего не любят"
          />
        </Field>
      ) : (
        <button
          type="button"
          onClick={() => setNotesOpen(true)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px] font-semibold transition"
        >
          <Plus size={15} strokeWidth={2.5} />
          Добавить заметку
        </button>
      )}
    </div>
  );
}
