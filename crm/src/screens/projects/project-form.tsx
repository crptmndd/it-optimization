import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Client } from "@/api/clients";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  WORK_TYPES,
  type Project,
  type ProjectInput,
  type ProjectStatus,
} from "@/api/projects";
import { DateField } from "@/components/date-field";
import { DeveloperPicker } from "@/components/developer-picker";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui";
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
    // Как есть, без подстановки true для сопровождения: она ушла бы на сервер при
    // обычном сохранении и включила бы признак у старого проекта.
    billingMonthly: project.billingMonthly,
  };
}

/**
 * Суммы и валюты здесь нет: они живут в блоке оплаты карточки, со своей кнопкой.
 * Если бы форма слала их тоже, общий «Сохранить» перезаписывал бы то, что там
 * уже сохранили.
 */
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
  };
}

/** Блок окна: мелкий заголовок и отступ вместо рамки. */
function FormBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

export function ProjectFields({
  values,
  onChange,
  clients,
  saved,
}: {
  values: ProjectFormValues;
  onChange: (values: ProjectFormValues) => void;
  clients: Client[];
  /** Что лежит в базе. У нового проекта этого нет. */
  saved?: Pick<Project, "workType" | "billingMonthly">;
}) {
  function set<K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  /**
   * Режим оплаты следует за видом работы, но только при настоящей смене. Повторный
   * выбор того же пункта ничего не значит, а возврат к сохранённому виду работы
   * возвращает сохранённый признак: иначе старое сопровождение с одного касания поля
   * получило бы все месяцы с начала работ в «Не выставлено», а старый договор молча
   * потерял бы помесячные документы.
   */
  function setWorkType(workType: string) {
    if (workType === values.workType) return;
    const billingMonthly =
      saved && workType === (saved.workType ?? "")
        ? saved.billingMonthly
        : workType === "support"
          ? true
          : workType === "contract"
            ? false
            : values.billingMonthly;
    onChange({ ...values, workType, billingMonthly });
  }

  const support = values.workType === "support";
  // Запоминается при открытии: иначе у старого договора переключатель исчезал бы прямо
  // под курсором, и случайное снятие было бы нечем вернуть.
  const [oldContractFlag] = useState(
    values.workType === "contract" && values.billingMonthly,
  );
  // На договоре переключатель скрыт, только если не стоит: старый договор со включённым
  // должен его видеть и иметь возможность снять.
  const showMonthly =
    values.workType !== "contract" || values.billingMonthly || oldContractFlag;

  const contractFilled = values.contractNumber !== "" || values.contractDate !== "";
  // Заполненное показывается сразу. Запоминается при открытии по той же причине: поле
  // не должно пропадать в момент, когда его стёрли, чтобы вписать другое.
  const [filledOnOpen] = useState({
    hosting: values.hosting !== "",
    description: values.description !== "",
    contract: contractFilled,
  });
  const [expanded, setExpanded] = useState(false);

  const showHosting = expanded || filledOnOpen.hosting;
  const showDescription = expanded || filledOnOpen.description;
  // На договоре его номер не редкость. А заполненное не прячется и после смены вида
  // работы: скрытое значение ушло бы на сервер незаметно для человека.
  const showContract =
    expanded || filledOnOpen.contract || contractFilled || values.workType === "contract";

  return (
    <div className="space-y-6">
      <FormBlock title="Основное">
        <Field label="Название">
          <Input
            value={values.title}
            onChange={(event) => set("title", event.target.value)}
            required
            autoFocus={!saved}
            maxLength={200}
            placeholder="Например, корпоративный сайт"
            className="h-12 text-base font-semibold"
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

          <Field label="Клиент">
            <Select
              value={values.clientId}
              onChange={(clientId) => set("clientId", clientId)}
              options={[
                { value: "", label: "Без клиента" },
                ...clients.map((client) => ({ value: client.id, label: client.name })),
              ]}
            />
          </Field>

          {showHosting && (
            <Field label="Хостинг" className="sm:col-span-2">
              <Input
                value={values.hosting}
                onChange={(event) => set("hosting", event.target.value)}
                maxLength={200}
                placeholder="reg.ru, аккаунт клиента"
              />
            </Field>
          )}

          {showDescription && (
            <Field label="О чём проект" className="sm:col-span-2">
              <Textarea
                value={values.description}
                onChange={(event) => set("description", event.target.value)}
                rows={3}
              />
            </Field>
          )}
        </div>

        {!(showHosting && showDescription && showContract) && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[13px] font-semibold transition"
          >
            <ChevronDown size={15} strokeWidth={2.5} />
            Показать остальное
          </button>
        )}
      </FormBlock>

      <FormBlock title="Кто и когда">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <DeveloperPicker
              value={values.developers}
              onChange={(next) => set("developers", next)}
            />
          </div>

          <Field label="Начали">
            <DateField
              value={values.startedDate}
              onChange={(next) => set("startedDate", next)}
              ariaLabel="Начали"
            />
          </Field>

          <Field label="Сдать до">
            <DateField
              value={values.deadlineDate}
              onChange={(next) => set("deadlineDate", next)}
              placeholder="Без срока"
              clearLabel="Убрать срок"
              ariaLabel="Сдать до"
              quick
            />
          </Field>
        </div>
      </FormBlock>

      <FormBlock title="Оплата">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Вид работы" className={showMonthly ? undefined : "sm:col-span-2"}>
            <Select
              value={values.workType}
              onChange={setWorkType}
              options={[
                { value: "", label: "Не указан" },
                ...WORK_TYPES.map((type) => ({ value: type.value, label: type.label })),
              ]}
            />
          </Field>

          {showMonthly && (
            <div className="self-end">
              <Switch
                checked={values.billingMonthly || support}
                disabled={support}
                onChange={(on) => set("billingMonthly", on)}
                label="Счёт каждый месяц"
                hint={
                  support
                    ? "Сопровождение всегда помесячно"
                    : "Счёт и акт появятся в начале месяца"
                }
              />
            </div>
          )}

          {showContract && (
            <>
              <Field label="Договор №">
                <Input
                  value={values.contractNumber}
                  onChange={(event) => set("contractNumber", event.target.value)}
                  maxLength={60}
                  placeholder="12/2026"
                />
              </Field>

              <Field label="Дата договора">
                <DateField
                  value={values.contractDate}
                  onChange={(next) => set("contractDate", next)}
                  ariaLabel="Дата договора"
                />
              </Field>
            </>
          )}
        </div>
      </FormBlock>
    </div>
  );
}
