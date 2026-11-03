"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/modules/verwaltung/actions";
import type { FloorPlanRoom } from "@/modules/verwaltung/grundriss";
import { pointStyle } from "@/ui/grundriss";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select, Textarea } from "@schulos/ui/field";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

/** RS-13: Grundriss hochladen bzw. ersetzen – mit Pflicht-Alternativtext und den Hinweisen „keine Personen“ und Fluchtplan. */
export function PlanUploadForm({ action, maxMb, altMax, altDefault, replace }: { action: Action; maxMb: number; altMax: number; altDefault: string; replace: boolean }) {
  const [state, formAction, pending] = useActionState(action, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} aria-label={replace ? "Grundriss ersetzen" : "Grundriss hochladen"} className="flex flex-col gap-4">
      <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        Nur den Plan der Etage hochladen – <strong>keine Personen und keine Namensschilder</strong> (z. B. Büros mit Namen) auf dem
        Bild. Erlaubt sind JPEG, PNG oder WebP; einen Plan als PDF bitte vorher als PNG exportieren. Das Bild wird auf 2400 Pixel
        verkleinert, Metadaten werden entfernt.
      </p>
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Grundriss gespeichert.
        </p>
      )}
      <Field label="Bild des Grundrisses" hint={`JPEG, PNG oder WebP, höchstens ${maxMb} MB${replace ? " – ersetzt den bisherigen Plan, die Punkte bleiben stehen" : ""}`} error={fe.plan}>
        <Input type="file" name="plan" accept="image/jpeg,image/png,image/webp" required className="py-2" />
      </Field>
      <Field label="Alternativtext (Pflicht)" hint="Was zeigt der Plan? z. B. „Langer Flur von West nach Ost, Treppenhaus in der Mitte, Fachräume im Ostflügel“" error={fe.alt}>
        <Textarea name="alt" required minLength={10} maxLength={altMax} rows={2} defaultValue={state.values?.alt ?? altDefault} />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Wird hochgeladen …" : replace ? "Plan ersetzen" : "Hochladen"}
        </Button>
      </div>
    </form>
  );
}

/** Alternativtext eines vorhandenen Plans ändern. */
export function PlanAltForm({ action, alt, altMax }: { action: Action; alt: string; altMax: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values;
  return (
    <form key={JSON.stringify(v ?? null)} action={formAction} aria-label="Alternativtext ändern" className="flex flex-col gap-2">
      <Field label="Alternativtext" hint="Beschreibt den Plan für alle, die das Bild nicht sehen" error={state.fieldErrors?.alt}>
        <Textarea name="alt" required minLength={10} maxLength={altMax} rows={2} defaultValue={v ? (v.alt ?? "") : alt} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          Alternativtext speichern
        </Button>
        {state.ok && (
          <p role="status" className="text-xs text-success">
            Gespeichert.
          </p>
        )}
      </div>
    </form>
  );
}

/** Plan löschen mit Rückfrage (leert auch alle Punkte der Etage). */
export function DeletePlanButton({ action }: { action: () => Promise<void> }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm("Grundriss löschen? Alle Punkte der Räume auf dieser Etage werden entfernt.")) e.preventDefault();
      }}
    >
      <Button type="submit" variant="ghost" size="sm" className="text-danger">
        Grundriss löschen
      </Button>
    </form>
  );
}

const pct = (v: number) => Math.round(v * 1000) / 10;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const fmt = (v: number) => pct(v).toLocaleString("de-DE", { maximumFractionDigits: 1 });

/**
 * Räume verorten: Raum wählen, dann auf den Plan klicken/tippen – oder per Tastatur den Punkt mit den Pfeiltasten verschieben
 * (Schritt 1 %, mit Umschalt 5 %) bzw. die Prozentwerte eintragen. Gespeichert wird erst mit „Punkt speichern“.
 */
export function PlanPointEditor({ action, src, width, height, alt, rooms }: { action: Action; src: string; width: number; height: number; alt: string; rooms: FloorPlanRoom[] }) {
  const [state, formAction, pending] = useActionState(action, {});
  const initialRoom = state.values?.room ?? rooms.find((r) => r.x === null)?.id ?? rooms[0]?.id ?? "";
  const [roomId, setRoomId] = useState(initialRoom);
  const room = rooms.find((r) => r.id === roomId) ?? null;
  const saved = room && room.x !== null && room.y !== null ? { x: room.x, y: room.y } : null;
  const [draft, setDraft] = useState<{ room: string; x: number; y: number } | null>(null);
  const point = draft && draft.room === roomId ? { x: draft.x, y: draft.y } : saved;
  const fe = state.fieldErrors ?? {};

  // Zahlenfelder ungesteuert: Klick/Pfeiltasten erhöhen `rev` und schreiben die Werte neu, Tippen ändert nur den Punkt
  const [rev, setRev] = useState(0);
  const move = (x: number, y: number, fromField = false) => {
    setDraft({ room: roomId, x: clamp(x), y: clamp(y) });
    if (!fromField) setRev((n) => n + 1);
  };

  function onPlanClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!room) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    move((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  }

  function onMarkerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const p = point ?? { x: 0.5, y: 0.5 };
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = d[e.key];
    if (!delta) return;
    e.preventDefault();
    move(p.x + delta[0], p.y + delta[1]);
  }

  function onNumber(field: "x" | "y", raw: string) {
    const n = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const p = point ?? { x: 0.5, y: 0.5 };
    move(field === "x" ? n / 100 : p.x, field === "y" ? n / 100 : p.y, true);
  }

  const unsaved = point && (!saved || saved.x !== point.x || saved.y !== point.y);
  return (
    <form action={formAction} aria-label="Räume auf dem Grundriss verorten" className="flex flex-col gap-4">
      {state.error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {state.error}
        </p>
      )}
      {state.ok && !state.error && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Gespeichert.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label="Raum" error={fe.room}>
          <Select
            name="room"
            value={roomId}
            onChange={(e) => {
              setRoomId(e.target.value);
              setDraft(null);
              setRev((n) => n + 1);
            }}
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
                {r.name !== r.id && r.name !== `Raum ${r.id}` ? ` – ${r.name}` : ""}
                {r.x === null ? " (noch nicht verortet)" : " (verortet)"}
                {r.active ? "" : " · stillgelegt"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Von links (%)" error={fe.x}>
          <Input
            key={`x-${roomId}-${rev}`}
            name="x"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            defaultValue={point ? pct(point.x) : ""}
            onChange={(e) => onNumber("x", e.target.value)}
          />
        </Field>
        <Field label="Von oben (%)" error={fe.y}>
          <Input
            key={`y-${roomId}-${rev}`}
            name="y"
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            defaultValue={point ? pct(point.y) : ""}
            onChange={(e) => onNumber("y", e.target.value)}
          />
        </Field>
      </div>
      <p className="text-sm text-muted">
        Auf den Plan klicken oder tippen setzt den Punkt für den gewählten Raum. Per Tastatur: den Punkt fokussieren und mit den
        Pfeiltasten verschieben (mit Umschalt in größeren Schritten) oder die Prozentwerte eintragen.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        {/* Klickfläche für Maus/Touch; Tastatur und Screenreader nutzen den Punkt bzw. die Zahlenfelder */}
        <div className="relative min-w-[32rem] cursor-crosshair bg-surface-2" onClick={onPlanClick}>
          {/* eslint-disable-next-line @next/next/no-img-element -- geschützte Route mit Sitzung, keine Bildoptimierung */}
          <img src={src} alt={alt} width={width} height={height} className="block h-auto w-full select-none" draggable={false} />
          {rooms
            .filter((r) => r.id !== roomId && r.x !== null && r.y !== null)
            .map((r) => (
              <span
                key={r.id}
                aria-hidden
                className="pointer-events-none absolute flex h-5 min-w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-surface bg-ink/70 px-1 text-[10px] leading-none font-semibold text-surface"
                style={pointStyle(r.x!, r.y!)}
              >
                {r.id}
              </span>
            ))}
          {room && (
            <button
              type="button"
              aria-label={
                point
                  ? `Punkt für Raum ${room.id}: ${fmt(point.x)} % von links, ${fmt(point.y)} % von oben. Pfeiltasten verschieben.`
                  : `Punkt für Raum ${room.id} setzen: Pfeiltasten drücken oder auf den Plan tippen.`
              }
              onKeyDown={onMarkerKey}
              onClick={(e) => {
                e.stopPropagation();
                if (!point) move(0.5, 0.5);
              }}
              className={cn(
                "absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full focus-visible:ring-4 focus-visible:ring-surface",
                !point && "opacity-60",
              )}
              style={pointStyle(point?.x ?? 0.5, point?.y ?? 0.5)}
            >
              <span aria-hidden className="flex h-8 min-w-8 items-center justify-center rounded-full border-2 border-surface bg-accent px-1.5 text-sm leading-none font-bold text-accent-fg shadow ring-4 ring-accent/40">
                {room.id}
              </span>
            </button>
          )}
        </div>
      </div>
      <p aria-live="polite" className="text-sm">
        {room && point
          ? `Raum ${room.id}: ${fmt(point.x)} % von links, ${fmt(point.y)} % von oben${unsaved ? " – noch nicht gespeichert" : ""}.`
          : room
            ? `Raum ${room.id} ist noch nicht verortet.`
            : "Auf dieser Etage gibt es keine Räume."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending || !room || !point}>
          Punkt speichern
        </Button>
        {saved && (
          <Button type="submit" name="remove" value="1" variant="ghost" className="text-danger" disabled={pending}>
            Punkt entfernen
          </Button>
        )}
      </div>
    </form>
  );
}
