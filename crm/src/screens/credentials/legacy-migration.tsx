import { ArchiveRestore } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { migrateSecrets, readLegacySecrets } from "@/api/credentials";
import { getVault } from "@/api/vault";
import { useSecondFactor } from "@/components/two-factor-prompt";
import { Button, ErrorNote, Field, Input, Modal } from "@/components/ui";
import { checkVerifier, decrypt, deriveKey } from "@/lib/vault";

/** Столько принимает поле пароля на сервере. */
const MAX_PASSWORD_LENGTH = 500;

/**
 * Разовый перенос старых паролей на серверное шифрование.
 *
 * Мастер-фразу знают только люди, поэтому расшифровывает браузер, а сервер получает
 * открытый текст по HTTPS и шифрует своим ключом. Колонка `secret` при этом не
 * очищается. Кнопка исчезает сама, когда переносить нечего.
 *
 * `watch` — список записей: новый пароль в карточке тоже снимает запись с переноса, и
 * число на кнопке должно за этим следить.
 */
export function LegacyMigration({
  watch,
  onDone,
}: {
  watch: unknown;
  onDone: () => void;
}) {
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getVault()
      .then((vault) => {
        if (!cancelled) setPending(vault.configured ? vault.secrets : 0);
      })
      .catch(() => {
        // Кнопка необязательна: без неё экран работает как обычно.
      });
    return () => {
      cancelled = true;
    };
  }, [watch]);

  if (pending === 0 && !open) return null;

  return (
    <>
      {pending > 0 && (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          <ArchiveRestore size={16} strokeWidth={2} />
          Перенести пароли ({pending})
        </Button>
      )}
      {open && <MigrationDialog onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

interface Outcome {
  migrated: number;
  skipped: number;
  failed: number;
}

function MigrationDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const { withCode, prompt } = useSecondFactor();
  // Фраза и расшифрованные пароли живут только здесь и уходят вместе с окном.
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const vault = await getVault();
      if (!vault.configured) {
        setError("Мастер-фраза не задавалась, переносить нечего");
        return;
      }

      const key = await deriveKey(phrase, vault.salt);
      if (!(await checkVerifier(key, vault.verifier))) {
        setError("Фраза не подходит");
        return;
      }

      const legacy = await withCode((code) => readLegacySecrets(code));
      if (!legacy) return;

      const items: { id: string; password: string }[] = [];
      let failed = 0;
      for (const item of legacy) {
        try {
          const password = await decrypt(key, item.secret);
          if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) failed += 1;
          else items.push({ id: item.id, password });
        } catch {
          // Зашифровано другой фразой: такие остаются на месте, пароль вводится заново.
          failed += 1;
        }
      }

      const result =
        items.length > 0
          ? await withCode((code) => migrateSecrets(items, code))
          : { migrated: 0, skipped: 0 };
      if (!result) return;

      setPhrase("");
      setOutcome({ ...result, failed });
      onDone();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не получилось перенести");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal title="Перенос паролей" onClose={onClose}>
        {outcome ? (
          <>
            <p className="text-sm">
              Перенесено {outcome.migrated}, не расшифровано {outcome.failed}
              {outcome.skipped > 0 ? `, пропущено ${outcome.skipped}` : ""}.
            </p>
            {outcome.failed > 0 && (
              <p className="text-muted-foreground mt-2 max-w-prose text-sm">
                Нерасшифрованные пароли остались на месте. Введите их заново в карточках.
              </p>
            )}
            <div className="mt-5">
              <Button type="button" onClick={onClose}>
                Готово
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p className="text-muted-foreground max-w-prose text-sm">
              Старые пароли зашифрованы мастер-фразой. Браузер расшифрует их и передаст
              серверу, и дальше они открываются кодом из приложения.
            </p>

            <div className="mt-4">
              <Field
                label="Старая мастер-фраза"
                hint="Фразы нет — введите пароли заново, старые при этом перестанут считаться"
              >
                <Input
                  type="password"
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  required
                  autoFocus
                  autoComplete="off"
                />
              </Field>
            </div>

            {error && (
              <div className="mt-4">
                <ErrorNote>{error}</ErrorNote>
              </div>
            )}

            <div className="mt-5 flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Переносим…" : "Перенести"}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                Отмена
              </Button>
            </div>
          </form>
        )}
      </Modal>
      {prompt}
    </>
  );
}
