import type { Client } from "@/api/clients";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  WORK_TYPES,
  type Project,
  type ProjectInput,
  type ProjectStatus,
} from "@/api/projects";
import { CurrencySelect } from "@/components/currency-select";
import { DeveloperPicker } from "@/components/developer-picker";
import { amountToInput, parseAmount, sanitizeAmount, type Currency } from "@/lib/money";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";

export interface ProjectFormValues {
  title: string;
  description: string;
  status: ProjectStatus;
  clientId: string;
  developers: string[];
  startedDate: string;
  deadlineDate: string;

  hosting: string;
  workType: string;
  contractNumber: string;
  contractDate: string;
  billingMonthly: boolean;
  currency: Currency;
  /** Строкой, а не числом: пустое поле ввода — это "", а не 0. */
  monthlyAmount: string;
}

export function emptyProjectValues(): ProjectFormValues {
  return {
    title: "",
    description: "",
    status: "planned",
    clientId: "",
    developers: [],
    startedDate: "",
    deadlineDate: "",
    hosting: "",
    workType: "",
    contractNumber: "",
    contractDate: "",
    billingMonthly: false,
    currency: "rub",
    monthlyAmount: "",
  };
}

export function projectToValues(project: Project): ProjectFormValues {
  return {
    title: project.title,
    description: project.description ?? "",
    status: project.status,
    clientId: project.client?.id ?? "",
    developers: project.developers,
    startedDate: toDateInputValue(project.startedAt),
    deadlineDate: toDateInputValue(project.deadline),
    hosting: project.hosting ?? "",
    workType: project.workType ?? "",
    contractNumber: project.contractNumber ?? "",
    contractDate: toDateInputValue(project.contractDate),
    billingMonthly: project.billingMonthly,
    currency: project.currency,
    monthlyAmount: amountToInput(project.monthlyAmountMinor),
  };
}

export function valuesToProjectInput(values: ProjectFormValues): ProjectInput {
  return {
    title: values.title.trim(),
    description: values.description.trim() || null,
    status: values.status,
    clientId: values.clientId || null,
    developers: values.developers,
    startedAt: fromDateInputValue(values.startedDate),
    deadline: fromDateInputValue(values.deadlineDate),
    hosting: values.hosting.trim() || null,
    workType: values.workType || null,
    contractNumber: values.contractNumber.trim() || null,
    contractDate: fromDateInputValue(values.contractDate),
    billingMonthly: values.billingMonthly,
    currency: values.currency,
    // Пустое поле — это «не задано», а не ноль.
    monthlyAmountMinor: parseAmount(values.monthlyAmount),
  };
}

export function ProjectFields({
  values,
  onChange,
  clients,
}: {
  values: ProjectFormValues;
  onChange: (values: ProjectFormValues) => void;
  clients: Client[];
}) {
  function set<K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-4">
      <Field label="Название">
        <Input
          value={values.title}
          onChange={(event) => set("title", event.target.value)}
          required
          autoFocus
          maxLength={200}
          placeholder="Корпоративный сайт · Интеграция с 1С"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Статус">
          <Select
            value={values.status}
            onChange={(next) => set("status", next as ProjectStatus)}
            options={PROJECT_STATUSES.map((item) => ({
              value: item,
              label: PROJECT_STATUS_LABELS[item],
            }))}
          />
        </Field>

        <Field label="Клиент" hint="Можно оставить пустым — например, для своих">
          <Select
            value={values.clientId}
            onChange={(clientId) => set("clientId", clientId)}
            options={[
              { value: "", label: "Без клиента" },
              ...clients.map((client) => ({ value: client.id, label: client.name })),
            ]}
          />
        </Field>
      </div>

      <DeveloperPicker
        value={values.developers}
        onChange={(next) => set("developers", next)}
        hint="Попадёт в утреннюю сводку в общий чат"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Начали">
          <Input
            type="date"
            value={values.startedDate}
            onChange={(event) => set("startedDate", event.target.value)}
          />
        </Field>

        <Field label="Сдать до" hint="По нему проект попадает в «Просрочено»">
          <Input
            type="date"
            value={values.deadlineDate}
            onChange={(event) => set("deadlineDate", event.target.value)}
          />
        </Field>
      </div>

      <div className="border-border space-y-4 border-t pt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Хостинг" hint="Где размещён и на чьём аккаунте">
            <Input
              value={values.hosting}
              onChange={(event) => set("hosting", event.target.value)}
              maxLength={200}
              placeholder="reg.ru, аккаунт клиента"
            />
          </Field>

          <Field label="Вид работы">
            <Select
              value={values.workType}
              onChange={(workType) => set("workType", workType)}
              options={[
                { value: "", label: "Не указан" },
                ...WORK_TYPES.map((type) => ({ value: type.value, label: type.label })),
              ]}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Договор №">
            <Input
              value={values.contractNumber}
              onChange={(event) => set("contractNumber", event.target.value)}
              maxLength={60}
              placeholder="12/2026"
            />
          </Field>

          <Field label="Дата договора">
            <Input
              type="date"
              value={values.contractDate}
              onChange={(event) => set("contractDate", event.target.value)}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={values.billingMonthly}
            onChange={(event) => set("billingMonthly", event.target.checked)}
            className="accent-accent mt-0.5 size-4 shrink-0"
          />
          <span className="text-sm">
            Счёт каждый месяц
            <span className="text-muted-foreground mt-0.5 block text-sm">
              Бот напомнит в общем чате, если за текущий месяц счёта ещё нет
            </span>
          </span>
        </label>

        {values.billingMonthly && (
          <Field
            label="Сумма в месяц"
            hint="Можно с копейками: 45000 или 5,19. Пустое — не задано"
          >
            <div className="flex gap-2">
              <Input
                value={values.monthlyAmount}
                onChange={(event) =>
                  set("monthlyAmount", sanitizeAmount(event.target.value))
                }
                inputMode="numeric"
                placeholder="45000"
              />
              <CurrencySelect
                value={values.currency}
                onChange={(currency) => set("currency", currency)}
              />
            </div>
          </Field>
        )}
      </div>

      <Field label="О чём проект">
        <Textarea
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          rows={3}
        />
      </Field>
    </div>
  );
}
