import { Check, Eye, EyeOff, Plus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import type { Credential, CredentialInput } from "@/api/credentials";
import { CurrencySelect } from "@/components/currency-select";
import { DateField } from "@/components/date-field";
import type { RevealPassword } from "@/components/two-factor-prompt";
import {
  Button,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  Switch,
  Textarea,
} from "@/components/ui";
import type { Project } from "@/api/projects";
import { cn } from "@/lib/cn";
import {
  formatDate,
  fromDateInputValue,
  nextRenewalDate,
  toDateInputValue,
} from "@/lib/dates";
import { amountToInput, parseAmount, sanitizeAmount, type Currency } from "@/lib/money";
import { ShownPassword, useShownPassword } from "./credential-card";

export interface FormValues {
  service: string;
  login: string;
  url: string;
  owner: string;
  projectId: string;
  renewsDate: string;
  amount: string;
  currency: Currency;
  monthlyFee: boolean;
  /** Новый пароль. Пусто — не менять: текущий в форму не попадает никогда. */
  password: string;
  /** Стереть пароль при сохранении. Отдельно: пустое поле значит «не менять». */
  clearPassword: boolean;
  notes: string;
}

export function empty(): FormValues {
  return {
    service: "",
    login: "",
    url: "",
    owner: "",
    projectId: "",
    renewsDate: "",
    amount: "",
    currency: "rub",
    monthlyFee: false,
    password: "",
    clearPassword: false,
    notes: "",
  };
}

export function toValues(item: Credential): FormValues {
  return {
    service: item.service,
    login: item.login ?? "",
    url: item.url ?? "",
    owner: item.owner ?? "",
    projectId: item.project?.id ?? "",
    renewsDate: toDateInputValue(item.renewsAt),
    amount: amountToInput(item.amountMinor),
    currency: item.currency ?? "rub",
    monthlyFee: item.monthlyFee ?? false,
    password: "",
    clearPassword: false,
    notes: item.notes ?? "",
  };
}

export function toInput(values: FormValues): CredentialInput {
  return {
    service: values.service.trim(),
    login: values.login.trim() || null,
    url: values.url.trim() || null,
    owner: values.owner.trim() || null,
    projectId: values.projectId || null,
    renewsAt: fromDateInputValue(values.renewsDate),
    amountMinor: parseAmount(values.amount),
    currency: values.currency,
    monthlyFee: values.monthlyFee,
    notes: values.notes.trim() || null,
    // Без trim: пробелы в пароле значимы. Поле опускается, а не шлётся пустым: иначе
    // обычное сохранение карточки стирало бы пароль.
    ...(values.clearPassword
      ? { password: null }
      : values.password && { password: values.password }),
  };
}

/** Форма ничего не расшифровывает при открытии: пароль только по нажатию. */
function CurrentPassword({ id, reveal }: { id: string; reveal: RevealPassword }) {
  const secret = useShownPassword(id, reveal);

  return (
    <div className="min-w-0">
      <span className="text-muted-foreground mb-1.5 block text-[13px] font-semibold">
        Текущий пароль
      </span>
      {secret.shown !== null ? (
        <ShownPassword password={secret.shown} />
      ) : (
        <p className="bg-field text-muted-foreground flex h-10 items-center rounded-lg px-3 text-sm">
          ••••••••
        </p>
      )}
      {secret.error && <p className="text-danger mt-1 text-xs">{secret.error}</p>}
      <div className="mt-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => (secret.shown === null ? void secret.show() : secret.hide())}
          disabled={secret.loading}
        >
          {secret.shown === null ? (
            <Eye size={15} strokeWidth={2.25} />
          ) : (
            <EyeOff size={15} strokeWidth={2.25} />
          )}
          {secret.shown === null ? "Показать" : "Скрыть"}
        </Button>
      </div>
    </div>
  );
}

/** Блок формы: мелкий заголовок вместо рамки, справа действие над его полями. */
function FormBlock({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      {/* min-h под кнопку: она появляется, пока вводят сумму, и поля не должны прыгать. */}
      <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
        <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

export function CredentialModal({
  title,
  initial,
  item,
  projects,
  reveal,
  onClose,
  onSubmit,
  onDelete,
}: {
  title: string;
  initial: FormValues;
  /** Сохранённая запись. Нет — создаём новую. */
  item?: Credential;
  projects: Project[];
  reveal: RevealPassword;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Сбрасывается вместе с окном: закрыли карточку — введённый пароль снова скрыт.
  const [revealed, setRevealed] = useState(false);
  // Заметки нужны не каждой записи: пустое поле только удлиняло окно.
  const [notesOpen, setNotesOpen] = useState(initial.notes !== "");
  const canClear = Boolean(item?.hasPassword || item?.legacyPending);

  /**
   * Куда уедет срок, если нажать «Оплатил». Считается заранее и стоит прямо на
   * кнопке: действие меняет дату, и человек должен видеть какую, а не нажимать
   * вслепую и потом искать, что изменилось.
   */
  const paidUntil = nextRenewalDate(values.renewsDate);
  /** То же условие, что в карточке записи, только по значениям формы. */
  const payable = values.renewsDate !== "" || parseAmount(values.amount) !== null;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

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
    if (!confirm("Удалить запись?")) return;
    setSaving(true);
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось удалить");
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="space-y-5">
          <div className="space-y-4">
            <Field label="Сервис">
              <Input
                value={values.service}
                onChange={(event) => set("service", event.target.value)}
                required
                autoFocus
                maxLength={120}
                placeholder="reg.ru · Яндекс Метрика · Cloudflare"
                className="h-12 text-base font-semibold"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Проект">
                <Select
                  value={values.projectId}
                  onChange={(projectId) => set("projectId", projectId)}
                  options={[
                    { value: "", label: "Без проекта" },
                    ...projects.map((project) => ({
                      value: project.id,
                      label: project.title,
                    })),
                  ]}
                />
              </Field>

              <Field label="На кого оформлен">
                <Input
                  value={values.owner}
                  onChange={(event) => set("owner", event.target.value)}
                  maxLength={120}
                  placeholder="Камиль"
                />
              </Field>
            </div>
          </div>

          <FormBlock title="Вход">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ссылка">
                <Input
                  value={values.url}
                  onChange={(event) => set("url", event.target.value)}
                  maxLength={300}
                  placeholder="https://reg.ru"
                />
              </Field>

              <Field label="Логин">
                <Input
                  value={values.login}
                  onChange={(event) => set("login", event.target.value)}
                  maxLength={200}
                />
              </Field>

              {item?.hasPassword && <CurrentPassword id={item.id} reveal={reveal} />}

              <Field
                label={item?.hasPassword ? "Новый пароль" : "Пароль"}
                hint={
                  item?.legacyPending
                    ? "Старый пароль ещё не перенесён. Новый заменит его"
                    : item?.hasPassword
                      ? "Пусто — не менять"
                      : "Шифруется на сервере. Пусто — пароль не хранится"
                }
                className={cn(!item?.hasPassword && "sm:col-span-2")}
              >
                {/*
                 * autoComplete обязателен: иначе браузер подставит пароль от CRM, и
                 * «Сохранить» молча заменит им пароль сервиса.
                 */}
                <div className="relative">
                  <Input
                    type={revealed ? "text" : "password"}
                    value={values.password}
                    onChange={(event) => set("password", event.target.value)}
                    disabled={values.clearPassword}
                    autoComplete="new-password"
                    maxLength={500}
                    className={cn(values.password && "pr-10", revealed && "font-mono")}
                  />
                  {values.password !== "" && (
                    <button
                      type="button"
                      onClick={() => setRevealed((shown) => !shown)}
                      aria-label={revealed ? "Скрыть пароль" : "Показать пароль"}
                      title={revealed ? "Скрыть" : "Показать"}
                      className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 transition"
                    >
                      {revealed ? (
                        <EyeOff size={15} strokeWidth={2.25} />
                      ) : (
                        <Eye size={15} strokeWidth={2.25} />
                      )}
                    </button>
                  )}
                </div>
              </Field>
            </div>

            {canClear && (
              <div className="mt-2">
                {values.clearPassword ? (
                  <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
                    Пароль будет стёрт при сохранении.
                    <button
                      type="button"
                      onClick={() => set("clearPassword", false)}
                      className="text-foreground underline underline-offset-2"
                    >
                      Отменить
                    </button>
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="-ml-3"
                    onClick={() => {
                      set("password", "");
                      set("clearPassword", true);
                    }}
                  >
                    Стереть пароль
                  </Button>
                )}
              </div>
            )}
          </FormBlock>

          {/* «Оплатил» стоит в заголовке блока, рядом с полем, которое меняет: это не
              способ закрыть форму, и в ряду с «Сохранить» и «Удалить» оно читалось бы
              как третий способ выйти из окна.

              Отдельной отметки «оплачено» у записи нет намеренно: оплата домена
              или подписки означает ровно одно — срок сдвинулся вперёд. Кнопка
              только подставляет дату в форму; записывается она обычным
              «Сохранить», поэтому промах отменяется закрытием окна. */}
          <FormBlock
            title="Оплата"
            action={
              payable && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => set("renewsDate", paidUntil)}
                  disabled={saving || values.renewsDate === paidUntil}
                  title={`Продлить срок до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
                >
                  <Check size={15} strokeWidth={2.5} />
                  Оплатил до {formatDate(fromDateInputValue(paidUntil) ?? "")}
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Продлить до">
                  <DateField
                    value={values.renewsDate}
                    onChange={(next) => set("renewsDate", next)}
                    placeholder="Без срока"
                    clearLabel="Убрать срок"
                    ariaLabel="Продлить до"
                  />
                </Field>

                <Field label="Сумма">
                  <div className="flex gap-2">
                    <Input
                      value={values.amount}
                      onChange={(event) =>
                        set("amount", sanitizeAmount(event.target.value))
                      }
                      inputMode="numeric"
                      placeholder="1200"
                    />
                    <CurrencySelect
                      value={values.currency}
                      onChange={(currency) => set("currency", currency)}
                    />
                  </div>
                </Field>
              </div>

              <Switch
                checked={values.monthlyFee}
                onChange={(monthlyFee) => set("monthlyFee", monthlyFee)}
                label="Списывается каждый месяц"
                hint="Иначе сумма считается платой за период продления"
              />
            </div>
          </FormBlock>

          {notesOpen ? (
            <Field label="Заметки">
              {/* Пустое поле открыли нажатием, и печатать будут сразу. У записи с
                  заметками оно открыто с начала, и фокус остаётся на «Сервисе». */}
              <Textarea
                value={values.notes}
                onChange={(event) => set("notes", event.target.value)}
                rows={3}
                autoFocus={values.notes === ""}
                placeholder="Тариф, что именно там лежит, к кому идти за доступом"
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
