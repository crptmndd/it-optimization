import { Check, Copy, ExternalLink, Eye, EyeOff, Lock, Pencil } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/api/client";
import type { Credential } from "@/api/credentials";
import type { RevealPassword } from "@/components/two-factor-prompt";
import { Badge, Button, Card } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  daysFromToday,
  describeDeadline,
  formatDate,
  fromDateInputValue,
  nextRenewalDate,
  toDateInputValue,
} from "@/lib/dates";
import { fee } from "@/lib/money";

/** Сколько дней до продления уже считается «скоро»: блок и метка в строке. */
const RENEW_SOON_DAYS = 14;

/** Срок просрочен или подходит: запись попадает в «Скоро продлить». */
export function renewsSoon(item: Credential): boolean {
  return item.renewsAt !== null && daysFromToday(item.renewsAt) <= RENEW_SOON_DAYS;
}

/**
 * Продлевать имеет смысл только то, за что платят. У записи без срока и без суммы —
 * логина от GitHub, общей почты — «Оплатил» означало бы неизвестно что.
 */
function isPayable(item: Credential): boolean {
  return item.renewsAt !== null || item.amountMinor != null;
}

/** Адрес вводят руками и часто без протокола: без него браузер счёл бы ссылку путём. */
function serviceHref(url: string): string {
  return url.startsWith("http") ? url : `https://${url}`;
}

/** В строке важен сам сайт: протокол и www только отодвигают его за край. */
function shortUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

const iconActionClass =
  "text-muted-foreground hover:bg-disabled hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-lg transition disabled:opacity-50";

/**
 * Дата стоит на самой кнопке, поэтому нажатие не вслепую. Подтверждения нет намеренно:
 * промах виден сразу по сроку рядом и правится в форме.
 */
export function PaidButton({
  item,
  onPaid,
  className,
}: {
  item: Credential;
  onPaid: () => Promise<void>;
  className?: string;
}) {
  const [saving, setSaving] = useState(false);
  const paidUntil = nextRenewalDate(toDateInputValue(item.renewsAt));

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={saving}
      className={className}
      onClick={() => {
        setSaving(true);
        void onPaid().finally(() => setSaving(false));
      }}
    >
      <Check size={15} strokeWidth={2.5} />
      {saving
        ? "Продлеваем…"
        : `Оплатил до ${formatDate(fromDateInputValue(paidUntil) ?? "")}`}
    </Button>
  );
}

/** Открытый пароль сам скрывается: забытый на экране он виден всем вокруг. */
const SHOWN_MS = 30_000;

/**
 * Показ пароля в карточке или форме. Значение живёт только в этом состоянии и
 * пропадает вместе с компонентом, поэтому закрытая карточка пароль не помнит.
 */
export function useShownPassword(id: string, reveal: RevealPassword) {
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setShown(null);
  }, []);

  useEffect(() => hide, [hide]);

  async function show() {
    setError(null);
    setLoading(true);
    try {
      const result = await reveal(id);
      if (!result) return;
      if (result.password === null) {
        setError("Пароль уже стёрт");
        return;
      }
      setShown(result.password);
      timer.current = setTimeout(hide, SHOWN_MS);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось открыть пароль");
    } finally {
      setLoading(false);
    }
  }

  return { shown, error, loading, show, hide };
}

function CopyButton({
  value,
  label,
  className = iconActionClass,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={failed ? "Не получилось скопировать" : label}
      className={cn(className, failed && "text-danger")}
    >
      {copied ? (
        <Check size={15} strokeWidth={2.5} className="text-success" />
      ) : (
        <Copy size={15} strokeWidth={2.25} />
      )}
    </button>
  );
}

/**
 * Копирование отдельной кнопкой, а не сразу после просмотра: Safari запрещает запись
 * в буфер после ожидания сети, вне жеста пользователя.
 */
export function ShownPassword({ password }: { password: string }) {
  return (
    <div className="bg-muted flex items-center gap-2 rounded-lg px-3 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-sm break-all whitespace-pre-wrap">
        {password}
      </code>
      <CopyButton
        value={password}
        label="Скопировать пароль"
        className="text-muted-foreground hover:bg-background hover:text-foreground shrink-0 rounded-lg p-1.5 transition"
      />
    </div>
  );
}

/**
 * Строка реквизита. Значение стоит вплотную к своим кнопкам: на широкой карточке иначе
 * между ними полэкрана. Место под две кнопки держится всегда: значения стоят по одному
 * краю, а открытый пароль не сдвигает значок под указателем.
 */
function Detail({
  label,
  actions,
  full = false,
  children,
}: {
  label: string;
  actions?: ReactNode;
  /** Своих кнопок нет, значение занимает и их место. */
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] gap-x-3 py-2">
      <dt className="text-muted-foreground py-1.5 text-[13px] leading-5 font-semibold">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 py-1.5 text-right text-sm leading-5 font-medium",
          full && "col-span-2",
        )}
      >
        {children}
      </dd>
      {!full && (
        <dd className="flex w-[4.125rem] items-start justify-end gap-0.5">{actions}</dd>
      )}
    </div>
  );
}

function PasswordDetail({ item, reveal }: { item: Credential; reveal: RevealPassword }) {
  const secret = useShownPassword(item.id, reveal);
  const { hide } = secret;

  // Список перечитан: запись могли поправить, а показанное значение уже устарело.
  useEffect(hide, [item, hide]);

  if (!item.hasPassword) {
    return (
      <Detail
        label="Пароль"
        actions={
          item.legacyPending && (
            <span
              title="Нажмите «Перенести пароли» вверху экрана"
              className="text-muted-foreground flex size-8 items-center justify-center"
            >
              <Lock size={17} strokeWidth={2.25} />
            </span>
          )
        }
      >
        <span className="text-muted-foreground">
          {item.legacyPending ? "Старый пароль ещё не перенесён" : "не задан"}
        </span>
      </Detail>
    );
  }

  const hidden = secret.shown === null;

  return (
    <Detail
      label="Пароль"
      actions={
        <>
          {!hidden && <CopyButton value={secret.shown!} label="Скопировать пароль" />}
          <button
            type="button"
            onClick={() => (hidden ? void secret.show() : secret.hide())}
            disabled={secret.loading}
            aria-label={hidden ? "Показать пароль" : "Скрыть пароль"}
            title={hidden ? "Показать пароль" : "Скрыть пароль"}
            className={iconActionClass}
          >
            {hidden ? (
              <Eye size={17} strokeWidth={2.25} />
            ) : (
              <EyeOff size={17} strokeWidth={2.25} />
            )}
          </button>
        </>
      }
    >
      {hidden ? (
        <span className="text-muted-foreground tracking-[0.15em]">••••••••</span>
      ) : (
        <code className="font-mono text-sm break-all whitespace-pre-wrap">
          {secret.shown}
        </code>
      )}
      {secret.error && <p className="text-danger mt-1 text-xs">{secret.error}</p>}
    </Detail>
  );
}

/**
 * Карточка записи: то, ради чего сюда приходят чаще всего, логин с паролем, плюс срок
 * оплаты. Править здесь нельзя намеренно, правка живёт в отдельной форме.
 *
 * Монтируется с `key` по id записи: смена записи обязана стереть открытый пароль.
 */
export function CredentialCard({
  item,
  reveal,
  onEdit,
  onPaid,
  inModal = false,
  className,
}: {
  item: Credential;
  reveal: RevealPassword;
  onEdit: () => void;
  onPaid: () => Promise<void>;
  /** В окне название уже в его заголовке, а «Изменить» уходит вниз, под большой палец. */
  inModal?: boolean;
  className?: string;
}) {
  const renews = item.renewsAt ? describeDeadline(item.renewsAt) : null;

  const edit = (
    <>
      <Pencil size={15} strokeWidth={2.25} />
      Изменить
    </>
  );

  const body = (
    <>
      {(item.project || item.owner) && (
        <p
          className={cn(
            "text-muted-foreground flex flex-wrap gap-x-3 text-sm font-medium [overflow-wrap:anywhere]",
            inModal ? "-mt-3 mb-2" : "mt-1",
          )}
        >
          {item.project && <span>{item.project.title}</span>}
          {item.owner && <span>Оформлено: {item.owner}</span>}
        </p>
      )}

      <dl className={cn("divide-border divide-y", !inModal && "mt-3")}>
        {item.login && (
          <Detail
            label="Логин"
            actions={<CopyButton value={item.login} label="Скопировать логин" />}
          >
            {/* Логин читают глазами, и на телефоне подсказки при наведении нет. */}
            <span className="[overflow-wrap:anywhere]">{item.login}</span>
          </Detail>
        )}

        <PasswordDetail item={item} reveal={reveal} />

        {item.url && (
          <Detail
            label="Ссылка"
            actions={
              <>
                <a
                  href={serviceHref(item.url)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Открыть сервис"
                  title="Открыть сервис"
                  className={iconActionClass}
                >
                  <ExternalLink size={16} strokeWidth={2.25} />
                </a>
                <CopyButton value={serviceHref(item.url)} label="Скопировать ссылку" />
              </>
            }
          >
            <span className="block truncate" title={item.url}>
              {shortUrl(item.url)}
            </span>
          </Detail>
        )}

        {isPayable(item) && (
          <Detail label="Оплата" full>
            {/* Отрицательный отступ: кнопка выше строки текста, и без него ряд с ней
                выходил бы выше соседних. */}
            <div className="-my-1.5 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              {item.amountMinor != null && (
                <span className="leading-8 font-semibold tabular-nums">
                  {fee(item.amountMinor, item.monthlyFee, item.currency)}
                </span>
              )}
              {renews && <Badge tone={renews.tone}>{renews.label}</Badge>}
              <PaidButton item={item} onPaid={onPaid} />
            </div>
          </Detail>
        )}

        {item.notes && (
          <div className="py-3.5">
            <dt className="text-muted-foreground text-[13px] leading-5 font-semibold">
              Заметки
            </dt>
            <dd className="mt-1 text-sm leading-5 font-medium [overflow-wrap:anywhere] whitespace-pre-wrap">
              {item.notes}
            </dd>
          </div>
        )}
      </dl>
    </>
  );

  if (inModal) {
    return (
      <>
        {body}
        <Button
          type="button"
          variant="secondary"
          onClick={onEdit}
          className="mt-4 h-11 w-full"
        >
          {edit}
        </Button>
      </>
    );
  }

  return (
    <Card className={cn("px-5 py-4 sm:px-6 sm:py-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-xl leading-8 font-extrabold tracking-tight [overflow-wrap:anywhere]">
          {item.service}
        </h2>
        <Button type="button" variant="secondary" size="sm" onClick={onEdit}>
          {edit}
        </Button>
      </div>
      {body}
    </Card>
  );
}
