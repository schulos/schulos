"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { savePlanAction } from "@/modules/sitzplan/actions";
import { MAX_COLS, MAX_ROWS, PRESETS, PRESET_LABELS, arrangeSeats, deskKey, keepSeatsOnDesks, parseDeskKey, presetDesks, type Preset, type Seat } from "@/modules/sitzplan/layout";
import type { PlanStudent } from "@/modules/sitzplan/service";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select } from "@schulos/ui/field";
import { Avatar } from "@schulos/ui/misc";

type Mode = "plaetze" | "tische";

const place = (row: number, col: number) => `Reihe ${row + 1}, Platz ${col + 1}`;

function randomSeed(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `${a[0]}-${a[1]}`;
}

/**
 * Sitzplan-Editor (P5-02). Zwei Arbeitsweisen: „Plätze“ (Schüler:innen setzen) und „Tische“ (Felder an/aus, Raster,
 * Vorlage). Setzen per Ziehen und Ablegen **oder** per Tastatur/Klick: Person wählen (Enter/Leertaste), dann Platz wählen –
 * ein besetzter Platz tauscht. Pfeiltasten bewegen den Fokus im Raster, Escape hebt die Auswahl auf. Gespeichert wird
 * alles zusammen mit „Speichern“.
 */
export function PlanEditor({
  planId,
  initial,
  students,
}: {
  planId: string;
  initial: { rows: number; cols: number; desks: string[]; seats: Seat[] };
  students: PlanStudent[];
}) {
  const [mode, setMode] = useState<Mode>("plaetze");
  const [rows, setRows] = useState(initial.rows);
  const [cols, setCols] = useState(initial.cols);
  const [desks, setDesks] = useState<string[]>(initial.desks);
  const [seats, setSeats] = useState<Seat[]>(initial.seats);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [result, setResult] = useState<{ ok?: boolean; error?: string }>({});
  const [pending, start] = useTransition();
  const [size, setSize] = useState({ rows: String(initial.rows), cols: String(initial.cols) });
  const [preset, setPreset] = useState<Preset>("reihen");
  const gridRef = useRef<HTMLDivElement>(null);

  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const deskSet = useMemo(() => new Set(desks), [desks]);
  const atDesk = useMemo(() => new Map(seats.map((s) => [deskKey(s.row, s.col), s.studentId])), [seats]);
  const seatedIds = useMemo(() => new Set(seats.map((s) => s.studentId)), [seats]);
  const unseated = students.filter((s) => !seatedIds.has(s.id));

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (next: Seat[], text?: string) => {
    setSeats(next);
    setDirty(true);
    setResult({});
    if (text) setAnnounce(text);
  };
  const changeDesks = (next: string[], text?: string) => {
    setDesks(next);
    const kept = keepSeatsOnDesks(seats, next);
    const lost = seats.length - kept.length;
    change(kept, [text, lost > 0 && `${lost} ${lost === 1 ? "Person hat" : "Personen haben"} den Platz verloren`].filter(Boolean).join(". "));
  };

  /** Person `id` auf den Tisch `row:col` setzen; sitzt dort jemand, tauschen beide. */
  const moveTo = (id: string, row: number, col: number) => {
    const s = byId.get(id);
    if (!s || !deskSet.has(deskKey(row, col))) return;
    const from = seats.find((x) => x.studentId === id);
    const other = atDesk.get(deskKey(row, col));
    if (other === id) return setSelected(null);
    let next = seats.filter((x) => x.studentId !== id && x.studentId !== other);
    next = [...next, { studentId: id, row, col }];
    if (other && from) next.push({ studentId: other, row: from.row, col: from.col });
    setSelected(null);
    const otherName = other ? byId.get(other)?.name : null;
    change(next, `${s.name} sitzt jetzt auf ${place(row, col)}${otherName ? (from ? `, ${otherName} auf ${place(from.row, from.col)}` : `, ${otherName} hat keinen Platz mehr`) : ""}`);
  };
  const unseat = (id: string) => {
    setSelected(null);
    change(
      seats.filter((x) => x.studentId !== id),
      `${byId.get(id)?.name ?? "Person"} hat keinen Platz mehr`,
    );
  };
  const select = (id: string | null) => {
    setSelected(id);
    setAnnounce(id ? `${byId.get(id)?.name} ausgewählt. Jetzt einen Platz wählen – Escape bricht ab.` : "Auswahl aufgehoben");
  };

  const onCell = (row: number, col: number) => {
    const k = deskKey(row, col);
    if (mode === "tische") {
      changeDesks(deskSet.has(k) ? desks.filter((d) => d !== k) : [...desks, k], `${place(row, col)}: ${deskSet.has(k) ? "kein Tisch" : "Tisch"}`);
      return;
    }
    if (!deskSet.has(k)) return;
    const here = atDesk.get(k);
    if (selected) moveTo(selected, row, col);
    else if (here) select(here);
  };

  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (selected) select(null);
      return;
    }
    const delta: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const d = delta[e.key];
    const el = e.target as HTMLElement;
    if (!d || el.dataset.row === undefined) return;
    e.preventDefault();
    // G4D-C10: in Pfeilrichtung bis zum nächsten bedienbaren Feld weitergehen (Gänge ohne Tisch sind in „Plätze“ deaktiviert)
    let r = Number(el.dataset.row);
    let c = Number(el.dataset.col);
    for (;;) {
      r += d[0];
      c += d[1];
      if (r < 0 || c < 0 || r >= rows || c >= cols) return;
      const next = gridRef.current?.querySelector<HTMLButtonElement>(`[data-row="${r}"][data-col="${c}"]`);
      if (next && !next.disabled) {
        next.focus();
        return;
      }
    }
  };

  const onDrop = (row: number, col: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/x-sitzplan");
    if (id) moveTo(id, row, col);
  };
  const drag = (id: string) => ({
    draggable: mode === "plaetze",
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/x-sitzplan", id);
      e.dataTransfer.effectAllowed = "move";
    },
  });

  const arrange = (how: "alphabetisch" | "zufaellig") => {
    if (seats.length > 0 && !confirm(`Alle Plätze neu verteilen (${how === "zufaellig" ? "zufällig" : "alphabetisch"})?`)) return;
    const next = arrangeSeats(
      students.map((s) => s.id),
      desks,
      how,
      randomSeed(),
    );
    const rest = students.length - next.length;
    change(next, `${next.length} Personen ${how === "zufaellig" ? "zufällig" : "alphabetisch"} verteilt${rest > 0 ? `, ${rest} ohne Platz (zu wenige Tische)` : ""}`);
  };

  const applySize = () => {
    const r = Number(size.rows);
    const c = Number(size.cols);
    if (!(r >= 1 && r <= MAX_ROWS && c >= 1 && c <= MAX_COLS)) return setResult({ error: `Raster: 1–${MAX_ROWS} Reihen, 1–${MAX_COLS} Plätze je Reihe` });
    setRows(r);
    setCols(c);
    changeDesks(
      desks.filter((d) => {
        const p = parseDeskKey(d)!;
        return p.row < r && p.col < c;
      }),
      `Raster ${r} × ${c}`,
    );
  };

  const save = () =>
    start(async () => {
      const r = await savePlanAction(planId, { rows, cols, desks, seats });
      setResult(r.error ? { error: r.error } : { ok: true });
      if (!r.error) {
        setDirty(false);
        setAnnounce("Sitzplan gespeichert");
      }
    });

  const sel = selected ? byId.get(selected) : null;

  return (
    <section aria-label="Sitzplan bearbeiten" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Bearbeiten" className="flex rounded-xl border border-border bg-surface-2 p-0.5">
          {(
            [
              ["plaetze", "Plätze"],
              ["tische", "Tische"],
            ] as const
          ).map(([m, label]) => (
            <label key={m} className={cn("flex min-h-9 cursor-pointer items-center rounded-lg px-3 text-sm text-muted", mode === m && "bg-surface font-semibold text-ink shadow-sm")}>
              <input
                type="radio"
                name="mode"
                value={m}
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  setSelected(null);
                }}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
        {mode === "plaetze" && (
          <>
            <Button type="button" size="sm" onClick={() => arrange("alphabetisch")}>
              Alphabetisch verteilen
            </Button>
            <Button type="button" size="sm" onClick={() => arrange("zufaellig")}>
              Zufällig verteilen
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={seats.length === 0}
              onClick={() => {
                if (confirm("Alle Plätze leeren?")) change([], "Alle Plätze geleert");
              }}
            >
              Alle Plätze leeren
            </Button>
          </>
        )}
        <span className="flex-1" />
        {dirty && <span className="text-sm text-warn">Nicht gespeichert</span>}
        <Button type="button" variant="primary" size="sm" disabled={pending || !dirty} onClick={save}>
          {pending ? "Speichern …" : "Speichern"}
        </Button>
      </div>

      {mode === "tische" && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface-2 p-3">
          <Field label="Reihen">
            <Input type="number" min={1} max={MAX_ROWS} value={size.rows} onChange={(e) => setSize((s) => ({ ...s, rows: e.target.value }))} className="w-20" />
          </Field>
          <Field label="Plätze je Reihe">
            <Input type="number" min={1} max={MAX_COLS} value={size.cols} onChange={(e) => setSize((s) => ({ ...s, cols: e.target.value }))} className="w-20" />
          </Field>
          <Button type="button" size="sm" onClick={applySize}>
            Raster übernehmen
          </Button>
          <Field label="Vorlage">
            <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="w-60">
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (seats.length === 0 || confirm("Vorlage anwenden? Personen auf wegfallenden Tischen verlieren ihren Platz.")) changeDesks(presetDesks(preset, rows, cols), `Vorlage „${PRESET_LABELS[preset]}“`);
            }}
          >
            Vorlage anwenden
          </Button>
          <p className="basis-full text-xs text-muted">Ein Feld anklicken (oder Enter) schaltet den Tisch an bzw. aus.</p>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
      {result.error && (
        <p role="alert" className="text-sm text-danger">
          {result.error}
        </p>
      )}
      {result.ok && (
        <p role="status" className="text-sm text-success">
          Sitzplan gespeichert.
        </p>
      )}
      {mode === "plaetze" && (
        <p className="text-sm text-muted" data-testid="sitzplan-hinweis">
          {sel
            ? `${sel.name} ausgewählt – jetzt einen Platz wählen (ein besetzter Platz tauscht). Escape bricht ab.`
            : "Ziehen und ablegen – oder eine Person wählen (Enter) und dann einen Platz. Pfeiltasten bewegen im Raster."}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
        <div className="flex flex-col gap-2 overflow-x-auto">
          <div className="rounded-lg bg-surface-2 py-1 text-center text-xs font-medium text-muted" aria-hidden>
            vorn · Tafel
          </div>
          <div ref={gridRef} role="group" aria-label="Raster" onKeyDown={onGridKey} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(4.5rem, 1fr))` }}>
            {Array.from({ length: rows * cols }, (_, i) => {
              const row = Math.floor(i / cols);
              const col = i % cols;
              const k = deskKey(row, col);
              const desk = deskSet.has(k);
              const sid = atDesk.get(k);
              const s = sid ? byId.get(sid) : undefined;
              const label = mode === "tische" ? `${place(row, col)}: ${desk ? "Tisch" : "kein Tisch"}` : `${place(row, col)}: ${s ? s.name : desk ? "frei" : "kein Tisch"}`;
              return (
                <button
                  key={k}
                  type="button"
                  data-row={row}
                  data-col={col}
                  aria-label={label}
                  aria-pressed={mode === "tische" ? desk : s ? selected === s.id : undefined}
                  disabled={mode === "plaetze" && !desk}
                  onClick={() => onCell(row, col)}
                  onDragOver={(e) => {
                    if (mode === "plaetze" && desk) e.preventDefault();
                  }}
                  onDrop={onDrop(row, col)}
                  {...(s ? drag(s.id) : {})}
                  className={cn(
                    "flex min-h-20 flex-col items-center justify-center gap-1 rounded-xl p-1 text-center text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]",
                    desk ? "border border-border-strong bg-surface" : "border border-dashed border-border bg-transparent",
                    mode === "plaetze" && !desk && "opacity-40",
                    s && selected === s.id && "ring-2 ring-[var(--accent)]",
                    mode === "tische" && "cursor-pointer",
                  )}
                >
                  {mode === "plaetze" && s && (
                    <>
                      <Avatar label={s.initials} src={s.photo} className="size-9" tone="soft" />
                      <span className="line-clamp-2 leading-tight font-medium">{s.name}</span>
                    </>
                  )}
                  {mode === "plaetze" && desk && !s && <span className="text-muted">frei</span>}
                  {mode === "tische" && desk && <span className="text-muted">Tisch</span>}
                </button>
              );
            })}
          </div>
        </div>
        {mode === "plaetze" && (
          <aside
            aria-labelledby="ohne-platz"
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/x-sitzplan");
              if (id && seatedIds.has(id)) unseat(id);
            }}
          >
            <h2 id="ohne-platz" className="text-sm font-semibold">
              Ohne Platz ({unseated.length})
            </h2>
            {unseated.length === 0 ? (
              <p className="text-xs text-muted">Alle sitzen.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {unseated.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      {...drag(s.id)}
                      aria-pressed={selected === s.id}
                      onClick={() => select(selected === s.id ? null : s.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && selected) select(null);
                      }}
                      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2", selected === s.id && "bg-accent-soft font-semibold")}
                    >
                      <Avatar label={s.initials} src={s.photo} className="size-7 text-[11px]" tone="soft" />
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {sel && seatedIds.has(sel.id) && (
              <Button type="button" size="sm" variant="ghost" onClick={() => unseat(sel.id)}>
                {sel.name}: Platz freigeben
              </Button>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
