import {
  CLOSED_STATUSES,
  LEAD_CHANNELS,
  LEAD_STATUS_LABELS,
  LEAD_STATUSES,
  type Lead,
  type LeadInput,
  type LeadStatus,
} from "@/api/leads";
import { memberLabel, type TeamMember } from "@/api/team";
import { DateField } from "@/components/date-field";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { SERVICES } from "@/lib/services";

/**
 * Форма держит строки, а не готовый запрос: `<input>` умеет работать только со
 * строками, и попытка хранить здесь `Date | null` превращает каждый обработчик
 * в разбор пустого значения.
 */
export interface LeadFormValues {
  name: string;
  contact: string;
  message: string;
  channel: string;
  service: string;
  status: LeadStatus;
  ownerId: string;
  nextActionDate: string;
  nextActionNote: string;
  lostReason: string;
}

export function emptyLeadValues(defaultOwnerId = ""): LeadFormValues {
  return {
    name: "",
    contact: "",
    message: "",
    channel: "",
    service: "",
    status: "new",
    ownerId: defaultOwnerId,
    nextActionDate: "",
    nextActionNote: "",
    lostReason: "",
  };
}

export function leadToValues(lead: Lead): LeadFormValues {
  return {
    name: lead.name ?? "",
    contact: lead.contact,
    message: lead.message ?? "",
    channel: lead.channel ?? "",
    service: lead.service ?? "",
    status: lead.status,
    ownerId: lead.owner?.id ?? "",
    nextActionDate: toDateInputValue(lead.nextActionAt),
    nextActionNote: lead.nextActionNote ?? "",
    lostReason: lead.lostReason ?? "",
  };
}

/** Пустая строка из формы значит «не заполнено» — на сервер уходит null. */
export function valuesToInput(values: LeadFormValues): LeadInput {
  return {
    name: values.name.trim() || null,
    contact: values.contact.trim(),
    message: values.message.trim() || null,
    channel: values.channel || null,
    service: values.service || null,
    status: values.status,
    ownerId: values.ownerId || null,
    nextActionAt: fromDateInputValue(values.nextActionDate),
    nextActionNote: values.nextActionNote.trim() || null,
    lostReason: values.lostReason.trim() || null,
  };
}

export function LeadFields({
  values,
  onChange,
  team,
}: {
  values: LeadFormValues;
  onChange: (values: LeadFormValues) => void;
  team: TeamMember[];
}) {
  const set = <K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) =>
    onChange({ ...values, [key]: value });

  const closed = CLOSED_STATUSES.includes(values.status);

  return (
    <div className="space-y-4">
      <Field label="Контакт">
        <Input
          value={values.contact}
          onChange={(event) => set("contact", event.target.value)}
          required
          placeholder="@ivanov или +7 999 123-45-67"
          className="h-12 text-base font-semibold"
        />
      </Field>

      <Field label="Что нужно">
        <Textarea
          value={values.message}
          onChange={(event) => set("message", event.target.value)}
          rows={3}
          placeholder="Своими словами: что просит, какой бюджет, когда надо"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Имя">
          <Input
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Необязательно"
          />
        </Field>

        <Field label="Откуда пришёл">
          <Select
            value={values.channel}
            onChange={(channel) => set("channel", channel)}
            ariaLabel="Откуда пришёл"
            options={[{ value: "", label: "Не указано" }, ...LEAD_CHANNELS]}
          />
        </Field>

        <Field label="Услуга">
          <Select
            value={values.service}
            onChange={(service) => set("service", service)}
            ariaLabel="Услуга"
            options={[
              { value: "", label: "Не определились" },
              ...SERVICES.map((service) => ({
                value: service.key,
                label: service.label,
              })),
            ]}
          />
        </Field>

        <Field label="Кто ведёт">
          <Select
            value={values.ownerId}
            onChange={(ownerId) => set("ownerId", ownerId)}
            ariaLabel="Кто ведёт"
            options={[
              { value: "", label: "Никто" },
              ...team.map((member) => ({ value: member.id, label: memberLabel(member) })),
            ]}
          />
        </Field>

        <Field label="Статус">
          <Select
            value={values.status}
            onChange={(status) => set("status", status as LeadStatus)}
            ariaLabel="Статус"
            options={LEAD_STATUSES.map((status) => ({
              value: status,
              label: LEAD_STATUS_LABELS[status],
            }))}
          />
        </Field>

        {/* Закрытому лиду дата не нужна — сервер всё равно снимет следующий шаг, —
            поэтому рядом со статусом стоит либо она, либо причина отказа. */}
        {!closed && (
          <Field label="Следующий шаг">
            <DateField
              value={values.nextActionDate}
              onChange={(next) => set("nextActionDate", next)}
              placeholder="Без напоминания"
              ariaLabel="Следующий шаг"
              quick
            />
          </Field>
        )}

        {values.status === "lost" && (
          <Field label="Почему отказ">
            <Input
              value={values.lostReason}
              onChange={(event) => set("lostReason", event.target.value)}
              placeholder="Дорого / нашли других / пропал"
            />
          </Field>
        )}
      </div>

      {/* Без описания напоминание сообщает только срок, и всё равно приходится
          открывать карточку, чтобы вспомнить, о чём речь. */}
      {!closed && (
        <Field label="Что сделать">
          <Input
            value={values.nextActionNote}
            onChange={(event) => set("nextActionNote", event.target.value)}
            maxLength={200}
            placeholder="Например, позвонить и отправить смету"
          />
        </Field>
      )}
    </div>
  );
}
