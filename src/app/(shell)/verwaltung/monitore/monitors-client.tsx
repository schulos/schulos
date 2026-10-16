"use client";

import { createContext, useActionState, useContext, useState, useSyncExternalStore, useTransition } from "react";
import { Copy, ExternalLink, KeyRound, Trash2 } from "lucide-react";
import { createScreenAction, deleteScreenAction, renewTokenAction, revokeTokenAction, updateScreenAction, type MonitorFormState } from "@/modules/monitor/actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";

const PROFILES = [
  { value: "foyer", label: "Foyer (Schüler:innen) – Lehrkräfte nur als Kürzel" },
  { value: "lehrerzimmer", label: "Lehrerzimmer – mit vertretenen Lehrkräften" },
  { value: "sprechtag", label: "Elternsprechtag – Lehrkräfte und Räume (ohne Namen der Familien)" },
] as const;

export interface ScreenRow {
  id: string;
  name: string;
  location: string | null;
  profile: "foyer" | "lehrerzimmer" | "sprechtag";
  active: boolean;
  lastSeen: string | null;
  boardId: string | null;
}

/** Pinnwände, deren Leitung die Anzeige auf Monitoren erlaubt (P3-09) */
const BoardsContext = createContext<{ id: string; title: string; groupName: string | null }[]>([]);

/** Zeigt die frisch erzeugte Adresse einmalig an */
function Issued({ issued }: { issued: NonNullable<MonitorFormState["issued"]> }) {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const [copied, setCopied] = useState(false);
  const url = `${origin}/monitor/${issued.token}`;
  return (
    <div role="status" className="flex flex-col gap-2 rounded-card border border-accent bg-accent-soft p-4 text-sm">
      <p className="font-semibold">Adresse für „{issued.name}“ – wird nur jetzt angezeigt</p>
      <code data-testid="monitor-url" className="break-all rounded-lg bg-surface px-3 py-2">
        {url}
      </code>
      <p className="text-muted">Im Browser des Bildschirms öffnen (Vollbild, z. B. F11). Wer die Adresse kennt, sieht den Monitor – bei Verlust neue Adresse erzeugen.</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true));
          }}
        >
          <Copy aria-hidden /> {copied ? "Kopiert" : "Kopieren"}
        </Button>
        <Button asChild size="sm" variant="ghost">
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden /> Öffnen
          </a>
        </Button>
      </div>
    </div>
  );
}

function ScreenFields({ v, initial, fe }: { v?: Record<string, string>; initial?: Partial<ScreenRow>; fe: Record<string, string> }) {
  const boards = useContext(BoardsContext);
  return (
    <>
      <Field label="Name" hint="z. B. Foyer Hauptgebäude" error={fe.name}>
        <Input name="name" defaultValue={v?.name ?? initial?.name ?? ""} required />
      </Field>
      <Field label="Ort" hint="Optional" error={fe.location}>
        <Input name="location" defaultValue={v?.location ?? initial?.location ?? ""} />
      </Field>
      <Field label="Profil" error={fe.profile} className="sm:col-span-2">
        <Select name="profile" defaultValue={v?.profile ?? initial?.profile ?? "foyer"}>
          {PROFILES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Pinnwand zusätzlich zeigen" hint="Nur Pinnwände, deren Leitung „auf Monitoren zeigen“ erlaubt hat" error={fe.boardId} className="sm:col-span-2">
        <Select name="boardId" defaultValue={v?.boardId ?? initial?.boardId ?? ""}>
          <option value="">keine</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.groupName ? ` (${b.groupName})` : ""}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

export function MonitorsClient({ screens, boards }: { screens: ScreenRow[]; boards: { id: string; title: string; groupName: string | null }[] }) {
  return (
    <BoardsContext value={boards}>
      <Screens screens={screens} />
    </BoardsContext>
  );
}

function Screens({ screens }: { screens: ScreenRow[] }) {
  const [state, formAction, pending] = useActionState(createScreenAction, {});
  const [renewed, setRenewed] = useState<MonitorFormState["issued"]>();
  const issued = renewed ?? state.issued;
  return (
    <div className="flex flex-col gap-6">
      {issued && <Issued key={issued.token} issued={issued} />}

      {screens.length > 0 && (
        <ul aria-label="Monitore" className="flex flex-col gap-3">
          {screens.map((s) => (
            <ScreenItem key={s.id} s={s} onIssued={setRenewed} />
          ))}
        </ul>
      )}

      <section aria-labelledby="neu" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-5">
        <h2 id="neu" className="font-semibold">
          Monitor anlegen
        </h2>
        <form key={state.issued?.token ?? JSON.stringify(state.values ?? null)} action={formAction} className="grid gap-4 sm:grid-cols-2">
          <ScreenFields v={state.values} fe={state.fieldErrors ?? {}} />
          {state.error && (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              {state.error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={pending}>
              Anlegen
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ScreenItem({ s, onIssued }: { s: ScreenRow; onIssued: (i: MonitorFormState["issued"]) => void }) {
  const [busy, start] = useTransition();
  const [state, formAction, pending] = useActionState(updateScreenAction.bind(null, s.id), {});
  return (
    <li className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-semibold">
            {s.name} {!s.active && <Badge tone="danger">gesperrt</Badge>}
          </span>
          <span className="text-sm text-muted">
            {[s.location, s.profile === "foyer" ? "Foyer" : "Lehrerzimmer", s.lastSeen ? `zuletzt gesehen ${s.lastSeen}` : "noch nie abgerufen"].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!s.active || confirm(`Neue Adresse für „${s.name}“ erzeugen? Die bisherige funktioniert dann nicht mehr.`)) start(async () => onIssued((await renewTokenAction(s.id, s.name)).issued));
            }}
          >
            <KeyRound aria-hidden /> Neue Adresse
          </Button>
          {s.active && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => confirm(`„${s.name}“ sperren? Der Bildschirm zeigt danach nichts mehr.`) && start(() => revokeTokenAction(s.id))}>
              Sperren
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            disabled={busy}
            aria-label={`${s.name} löschen`}
            onClick={() => confirm(`Monitor „${s.name}“ löschen?`) && start(() => deleteScreenAction(s.id))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-accent-ink">Bearbeiten</summary>
        <form key={JSON.stringify(state.values ?? null)} action={formAction} className="mt-3 grid gap-4 sm:grid-cols-2">
          <ScreenFields v={state.values} initial={s} fe={state.fieldErrors ?? {}} />
          {state.error && (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              {state.error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              Speichern
            </Button>
          </div>
        </form>
      </details>
    </li>
  );
}
