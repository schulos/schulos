"use client";

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import {
  addCardAction,
  addColumnAction,
  addMemberAction,
  approveCardAction,
  deleteBoardAction,
  deleteCardAction,
  deleteColumnAction,
  moveCardAction,
  removeMemberAction,
  renameColumnAction,
  updateBoardAction,
} from "@/modules/pinnwaende/actions";
import type { FormState } from "@/modules/verwaltung/actions";
import { passiveRefresh } from "@schulos/ui/auto-refresh";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";
import { useLive } from "../../_shell/live";
import { MODES } from "../new-board";

/** Lädt die Pinnwand neu, sobald jemand etwas ändert (SSE-Ereignis „board“). */
export function LiveRefresh({ boardId }: { boardId: string }) {
  const router = useRouter();
  useLive((m) => {
    if (m.type === "board" && m.boardId === boardId) passiveRefresh(router); // G4E-C01: keine Aktivität der Person
  });
  return null;
}

export function CardForm({ boardId, columnId, columnTitle, files }: { boardId: string; columnId: string; columnTitle: string; files: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("text");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [fileId, setFileId] = useState(files[0]?.id ?? "");
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const next = await addCardAction(boardId, columnId, prev, form);
    if (next.ok) {
      setTitle("");
      setBody("");
      setUrl("");
      setOpen(false);
    }
    return next;
  }, {});
  if (!open)
    return (
      <Button size="sm" variant="ghost" aria-label={`Karte in ${columnTitle} hinzufügen`} onClick={() => setOpen(true)}>
        <Plus aria-hidden /> Karte
      </Button>
    );
  return (
    <form action={formAction} aria-label={`Neue Karte in ${columnTitle}`} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
      <Field label="Art">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="text">Text</option>
          <option value="link">Link</option>
          {files.length > 0 && <option value="file">Datei aus dem Gruppenordner</option>}
        </Select>
      </Field>
      <Field label="Titel">
        <Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
      </Field>
      {kind === "link" && (
        <Field label="Adresse">
          <Input name="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required />
        </Field>
      )}
      {kind === "file" && (
        <Field label="Datei">
          <Select name="fileId" value={fileId} onChange={(e) => setFileId(e.target.value)}>
            {files.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Text" hint="Optional">
        <Textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={2000} />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={pending}>
          Anheften
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Abbrechen
        </Button>
      </div>
    </form>
  );
}

export function CardActions({ boardId, cardId, title, approve, remove }: { boardId: string; cardId: string; title: string; approve: boolean; remove: boolean }) {
  const [pending, start] = useTransition();
  return (
    <div className="flex gap-1">
      {approve && (
        <Button size="sm" variant="ghost" aria-label={`„${title}“ freigeben`} disabled={pending} onClick={() => start(() => approveCardAction(boardId, cardId))}>
          <Check aria-hidden /> Freigeben
        </Button>
      )}
      {remove && (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`„${title}“ löschen`}
          disabled={pending}
          onClick={() => {
            if (confirm(`Karte „${title}“ löschen?`)) start(() => deleteCardAction(boardId, cardId));
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      )}
    </div>
  );
}

export function ColumnMenu({ boardId, columnId, title }: { boardId: string; columnId: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Spalte „${title}“ umbenennen`}
          disabled={pending}
          onClick={() => {
            const next = prompt("Neuer Titel der Spalte", title);
            if (next && next !== title) start(async () => setError(await renameColumnAction(boardId, columnId, next)));
          }}
        >
          Umbenennen
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Spalte „${title}“ löschen`} disabled={pending} onClick={() => start(async () => setError(await deleteColumnAction(boardId, columnId)))}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function AddColumn({ boardId }: { boardId: string }) {
  const [title, setTitle] = useState("");
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const next = await addColumnAction(boardId, prev, form);
    if (next.ok) setTitle("");
    return next;
  }, {});
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <Field label="Neue Spalte" error={state.error}>
        <Input name="column" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} required />
      </Field>
      <Button type="submit" disabled={pending}>
        <Plus aria-hidden /> Spalte
      </Button>
    </form>
  );
}

export function BoardSettings({ boardId, title, mode, onMonitor }: { boardId: string; title: string; mode: string; onMonitor: boolean }) {
  const [t, setT] = useState(title);
  const [m, setM] = useState(mode);
  const [mon, setMon] = useState(onMonitor);
  const [state, formAction, pending] = useActionState(updateBoardAction.bind(null, boardId), {} as FormState);
  const [deleting, start] = useTransition();
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <Field label="Titel" error={state.fieldErrors?.title}>
        <Input name="title" value={t} onChange={(e) => setT(e.target.value)} maxLength={100} required />
      </Field>
      <Field label="Wer postet?">
        <Select name="mode" value={m} onChange={(e) => setM(e.target.value)}>
          {MODES.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </Select>
      </Field>
      {/* SEC-05: Monitore hängen öffentlich (Foyer) – nur Pinnwände, deren Karten die Leitung prüft */}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="onMonitor"
          checked={mon && m !== "alle"}
          disabled={m === "alle"}
          onChange={(e) => setMon(e.target.checked)}
          aria-describedby={`monitor-hint-${boardId}`}
          className="size-4 accent-[var(--accent)]"
        />
        Auf Monitoren zeigen (ohne Namen und Bilder)
      </label>
      <p id={`monitor-hint-${boardId}`} className="basis-full text-xs text-muted">
        {state.fieldErrors?.onMonitor ??
          "Nur bei „Nur Leitung postet“ oder „Alle posten, Leitung gibt frei“: Monitore zeigen nur freigegebene Karten. Beim Wechsel weg von „Alle posten“ warten Karten von Mitgliedern auf Freigabe."}
      </p>
      <Button type="submit" disabled={pending}>
        Speichern
      </Button>
      <Button
        type="button"
        variant="danger"
        disabled={deleting}
        onClick={() => {
          if (confirm("Pinnwand mit allen Karten löschen?")) start(() => deleteBoardAction(boardId));
        }}
      >
        Pinnwand löschen
      </Button>
    </form>
  );
}

export function Members({ boardId, members }: { boardId: string; members: { id: string; name: string; leader: boolean }[] }) {
  const [username, setUsername] = useState("");
  const [state, formAction, pending] = useActionState(async (prev: FormState, form: FormData) => {
    const next = await addMemberAction(boardId, prev, form);
    if (next.ok) setUsername("");
    return next;
  }, {});
  const [removing, start] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-2">
        {members.map((m) => (
          <li key={m.id} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-1 pr-1 pl-3 text-sm">
            {m.name}
            <button type="button" aria-label={`${m.name} entfernen`} disabled={removing} className="grid size-6 place-items-center rounded-full hover:bg-surface" onClick={() => start(() => removeMemberAction(boardId, m.id))}>
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
        {members.length === 0 && <li className="text-sm text-muted">Noch keine Mitglieder.</li>}
      </ul>
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <Field label="Benutzername" error={state.error}>
          <Input name="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="vorname.nachname" required />
        </Field>
        <Button type="submit" disabled={pending}>
          Hinzufügen
        </Button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------- Verschieben (P3-09): Ziehen mit der Maus, Knöpfe für die Tastatur

const DRAG_TYPE = "application/x-schulos-card";

/** Karte als Zugquelle; Ablegen auf einer Karte setzt die gezogene davor. */
export function DraggableCard({
  boardId,
  cardId,
  columnId,
  index,
  canMove,
  children,
}: {
  boardId: string;
  cardId: string;
  columnId: string;
  index: number;
  canMove: boolean;
  children: React.ReactNode;
}) {
  const [, start] = useTransition();
  const [over, setOver] = useState(false);
  return (
    <li
      draggable={canMove}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, cardId)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setOver(false);
        if (!id || id === cardId) return;
        e.preventDefault();
        e.stopPropagation();
        start(() => moveCardAction(boardId, id, columnId, index));
      }}
      className={cn("flex flex-col gap-2 rounded-xl border bg-surface p-3", over ? "border-accent" : "border-border", canMove && "cursor-grab")}
    >
      {children}
    </li>
  );
}

/** Spalte als Ablage: ans Ende der Spalte. */
export function DropColumn({ boardId, columnId, count, label, children }: { boardId: string; columnId: string; count: number; label: string; children: React.ReactNode }) {
  const [, start] = useTransition();
  return (
    <ul
      aria-label={label}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        start(() => moveCardAction(boardId, id, columnId, count));
      }}
      className="flex min-h-12 flex-col gap-2"
    >
      {children}
    </ul>
  );
}

type Neighbor = { id: string; title: string; count: number } | null;

/** Tastaturbedienung: nach oben/unten in der Spalte, nach links/rechts ans Ende der Nachbarspalte. */
export function MoveButtons({
  boardId,
  cardId,
  title,
  columnId,
  index,
  count,
  prevColumn,
  nextColumn,
}: {
  boardId: string;
  cardId: string;
  title: string;
  columnId: string;
  index: number;
  count: number;
  prevColumn: Neighbor;
  nextColumn: Neighbor;
}) {
  const [pending, start] = useTransition();
  const move = (col: string, i: number) => start(() => moveCardAction(boardId, cardId, col, i));
  return (
    <div className="flex gap-0.5" role="group" aria-label={`„${title}“ verschieben`}>
      <Button size="sm" variant="ghost" className="px-2" aria-label={`„${title}“ nach oben`} disabled={pending || index === 0} onClick={() => move(columnId, index - 1)}>
        <ArrowUp aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" className="px-2" aria-label={`„${title}“ nach unten`} disabled={pending || index === count - 1} onClick={() => move(columnId, index + 1)}>
        <ArrowDown aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="px-2"
        aria-label={prevColumn ? `„${title}“ nach ${prevColumn.title}` : `„${title}“ nach links`}
        disabled={pending || !prevColumn}
        onClick={() => prevColumn && move(prevColumn.id, prevColumn.count)}
      >
        <ArrowLeft aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="px-2"
        aria-label={nextColumn ? `„${title}“ nach ${nextColumn.title}` : `„${title}“ nach rechts`}
        disabled={pending || !nextColumn}
        onClick={() => nextColumn && move(nextColumn.id, nextColumn.count)}
      >
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}
