import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  addNote,
  deleteLead,
  getLead,
  updateLead,
  type Lead,
  type Note,
} from "@/api/leads";
import { memberLabel, type TeamMember } from "@/api/team";
import { NotesView } from "@/components/notes-panel";
import { Button, ErrorNote, LoadingRows, Modal } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import {
  LeadFields,
  leadToValues,
  valuesToInput,
  type LeadFormValues,
} from "./lead-form";

export function LeadDetail({
  leadId,
  team,
  onClose,
  onChanged,
}: {
  leadId: string;
  team: TeamMember[];
  onClose: () => void;
  /** Список наверху перезагружается сам: правка меняет и порядок, и фильтры. */
  onChanged: () => void;
}) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [values, setValues] = useState<LeadFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    getLead(leadId)
      .then((data) => {
        if (cancelled) return;
        setLead(data.lead);
        setNotes(data.notes);
        setValues(leadToValues(data.lead));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describe(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateLead(leadId, valuesToInput(values));
      setLead(updated);
      setValues(leadToValues(updated));
      onChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSaving(false);
    }
  }

  async function handleAddNote() {
    const body = noteDraft.trim();
    if (!body) return;
    setError(null);
    try {
      const note = await addNote(leadId, body);
      setNotes((current) => [...current, note]);
      setNoteDraft("");
    } catch (cause) {
      setError(describe(cause));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Удалить лид? Заметки к нему тоже исчезнут.")) return;
    setError(null);
    try {
      await deleteLead(leadId);
      onChanged();
      onClose();
    } catch (cause) {
      setError(describe(cause));
    }
  }

  return (
    <Modal title={lead?.name ?? lead?.contact ?? "Лид"} onClose={onClose}>
      {!values && !error && <LoadingRows rows={5} />}
      {!values && error && <ErrorNote>{error}</ErrorNote>}

      {values && (
        <form onSubmit={handleSave}>
          <LeadFields values={values} onChange={setValues} team={team} />

          <div className="mt-6">
            <NotesView
              notes={notes}
              draft={noteDraft}
              onDraftChange={setNoteDraft}
              onSubmit={() => void handleAddNote()}
              placeholder="Позвонил, попросил счёт до пятницы"
            />
          </div>

          {lead && (
            <p className="text-muted-foreground mt-5 flex flex-wrap gap-x-3 text-xs font-medium">
              <span>Создан {formatDateTime(lead.createdAt)}</span>
              {lead.owner && <span>Ведёт {memberLabel(lead.owner)}</span>}
            </p>
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
            <Button
              type="button"
              variant="danger"
              className="h-11"
              onClick={() => void handleDelete()}
            >
              Удалить
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : "Что-то пошло не так";
}
