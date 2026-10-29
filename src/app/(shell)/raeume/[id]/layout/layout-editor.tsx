"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { arrowDelta, cellKey } from "@/core/raster";
import {
  ELEMENT_LABELS,
  ELEMENT_SHORT,
  LAYOUT_ELEMENTS,
  LAYOUT_NAME_MAX,
  LAYOUT_VARIANTS,
  MAX_COLS,
  MAX_ROWS,
  VARIANT_LABELS,
  capacityHint,
  cellLabel,
  cropCells,
  examSeatKeys,
  seatCount,
  variantCells,
  type LayoutCells,
  type LayoutElement,
  type LayoutVariant,
} from "@/core/raumlayout-raster";
import { saveRoomLayoutAction } from "@/modules/verwaltung/raum-daten-actions";
import { elementClass } from "@/ui/raumlayout";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Field, Input, Select } from "@schulos/ui/field";

type Tool = LayoutElement | "leer";

/**
 * RS-08 Raumlayout-Editor – Raster wie im Sitzplan (bis 12 × 12), keine freie Zeichnung. Ein Element wählen (Platz, Tisch,
 * Pult, Tafel/Display, Tür, Fenster, Schrank, Waschbecken, Abzug oder „leeren“), dann Felder anklicken bzw. mit Enter/Leertaste
 * setzen; dasselbe Element noch einmal leert das Feld. Pfeiltasten bewegen im Raster (ein Feld ist Tabstopp), Entf leert.
 * Gespeichert wird alles zusammen.
 */
export function LayoutEditor({
  roomId,
  layoutId,
  capacity,
  initial,
}: {
  roomId: string;
  /** null = neues Layout */
  layoutId: string | null;
  capacity: number | null;
  initial: { name: string; variant: LayoutVariant; rows: number; cols: number; cells: LayoutCells };
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [variant, setVariant] = useState<LayoutVariant>(initial.variant);
  const [rows, setRows] = useState(initial.rows);
  const [cols, setCols] = useState(initial.cols);
  const [cells, setCells] = useState<LayoutCells>(initial.cells);
  const [size, setSize] = useState({ rows: String(initial.rows), cols: String(initial.cols) });
  const [tool, setTool] = useState<Tool>("platz");
  const [focus, setFocus] = useState<[number, number]>([0, 0]);
  const [dirty, setDirty] = useState(layoutId === null);
  const [announce, setAnnounce] = useState("");
  const [result, setResult] = useState<{ ok?: boolean; error?: string; fieldErrors?: Record<string, string> }>({});
  const [pending, start] = useTransition();
  const gridRef = useRef<HTMLDivElement>(null);

  const seats = useMemo(() => seatCount(cells), [cells]);
  const exam = useMemo(() => examSeatKeys(cells, variant).length, [cells, variant]);
  const hint = capacityHint(seats, capacity);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = (text: string) => {
    setDirty(true);
    setResult({});
    setAnnounce(text);
  };

  const apply = (row: number, col: number, t: Tool = tool) => {
    const k = cellKey(row, col);
    const next = { ...cells };
    const cur = next[k];
    if (t === "leer" || cur === t) delete next[k];
    else next[k] = t;
    setCells(next);
    touch(cellLabel(row, col, next[k]));
  };

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.dataset.row === undefined) return;
    const r = Number(el.dataset.row);
    const c = Number(el.dataset.col);
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      apply(r, c, "leer");
      return;
    }
    const d = arrowDelta(e.key);
    if (!d) return;
    e.preventDefault();
    const nr = Math.min(rows - 1, Math.max(0, r + d[0]));
    const nc = Math.min(cols - 1, Math.max(0, c + d[1]));
    setFocus([nr, nc]);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-row="${nr}"][data-col="${nc}"]`)?.focus();
  };

  const applySize = () => {
    const r = Number(size.rows);
    const c = Number(size.cols);
    if (!(Number.isInteger(r) && Number.isInteger(c) && r >= 1 && r <= MAX_ROWS && c >= 1 && c <= MAX_COLS))
      return setResult({ error: `Raster: 1–${MAX_ROWS} Reihen, 1–${MAX_COLS} Spalten` });
    setRows(r);
    setCols(c);
    setCells(cropCells(cells, r, c));
    setFocus(([fr, fc]) => [Math.min(fr, r - 1), Math.min(fc, c - 1)]);
    touch(`Raster ${r} × ${c}`);
  };

  const applyVariant = () => {
    if (Object.keys(cells).length > 0 && !confirm(`Raster mit der Vorlage „${VARIANT_LABELS[variant]}“ neu füllen? Bisherige Elemente gehen verloren.`)) return;
    const next = variantCells(variant, rows, cols);
    setCells(next);
    touch(`Vorlage „${VARIANT_LABELS[variant]}“: ${seatCount(next)} Plätze`);
  };

  const save = () =>
    start(async () => {
      const r = await saveRoomLayoutAction(roomId, layoutId, { name, variant, rows, cols, cells });
      if (r.error) {
        setResult({ error: r.error, fieldErrors: r.fieldErrors });
        return;
      }
      setDirty(false);
      setResult({ ok: true });
      setAnnounce("Layout gespeichert");
      if (!layoutId && r.id) router.push(`/raeume/${encodeURIComponent(roomId)}/layout?l=${encodeURIComponent(r.id)}&gespeichert=1`);
      else router.refresh();
    });

  const fe = result.fieldErrors ?? {};

  return (
    <section aria-label="Layout bearbeiten" className="flex flex-col gap-4">
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted sm:hidden">Bearbeiten geht am besten auf einem großen Bildschirm – das Raster lässt sich seitlich scrollen.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name" error={fe.name} hint="z. B. „Standard“ oder „Klausur“">
          <Input
            name="name"
            value={name}
            maxLength={LAYOUT_NAME_MAX}
            required
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <Field label="Variante" error={fe.variant} hint="„Prüfung“: alle Plätze zählen als Prüfungsplätze">
          <Select
            value={variant}
            onChange={(e) => {
              setVariant(e.target.value as LayoutVariant);
              setDirty(true);
            }}
          >
            {LAYOUT_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {VARIANT_LABELS[v]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end lg:col-span-2">
          <Button type="button" size="sm" onClick={applyVariant}>
            Vorlage der Variante anwenden
          </Button>
        </div>
        <Field label="Reihen" hint="Reihe 1 ist vorn">
          <Input type="number" min={1} max={MAX_ROWS} value={size.rows} onChange={(e) => setSize((s) => ({ ...s, rows: e.target.value }))} />
        </Field>
        <Field label="Spalten">
          <Input type="number" min={1} max={MAX_COLS} value={size.cols} onChange={(e) => setSize((s) => ({ ...s, cols: e.target.value }))} />
        </Field>
        <div className="flex items-end lg:col-span-2">
          <Button type="button" size="sm" onClick={applySize}>
            Raster übernehmen
          </Button>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Element setzen</legend>
        <div role="radiogroup" aria-label="Element" className="flex flex-wrap gap-1">
          {([...LAYOUT_ELEMENTS, "leer"] as Tool[]).map((t) => (
            <label
              key={t}
              className={cn(
                "flex min-h-9 cursor-pointer items-center rounded-lg border border-border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent)]",
                tool === t ? "bg-accent-soft font-semibold text-accent-ink" : "bg-surface text-ink",
              )}
            >
              <input type="radio" name="tool" value={t} checked={tool === t} onChange={() => setTool(t)} className="sr-only" />
              {t === "leer" ? "Feld leeren" : ELEMENT_LABELS[t]}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          Feld anklicken bzw. mit Enter oder Leertaste setzen – dasselbe Element noch einmal leert das Feld. Pfeiltasten bewegen im Raster, Entf leert.
        </p>
      </fieldset>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      <div className="flex flex-col gap-2 overflow-x-auto">
        <div className="rounded-lg bg-surface-2 py-1 text-center text-xs font-medium text-muted" aria-hidden>
          vorn
        </div>
        <div
          ref={gridRef}
          role="group"
          aria-label={`Raster ${rows} × ${cols}`}
          onKeyDown={onKey}
          className="grid min-w-max gap-1"
          style={{ gridTemplateColumns: `repeat(${cols}, 3.5rem)` }}
        >
          {Array.from({ length: rows * cols }, (_, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const el = cells[cellKey(row, col)];
            const isFocus = focus[0] === row && focus[1] === col;
            return (
              <button
                key={cellKey(row, col)}
                type="button"
                data-row={row}
                data-col={col}
                tabIndex={isFocus ? 0 : -1}
                aria-label={cellLabel(row, col, el)}
                onFocus={() => setFocus([row, col])}
                onClick={() => apply(row, col)}
                className={cn(
                  "flex h-12 items-center justify-center rounded-lg p-0.5 text-center text-[11px] leading-tight focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]",
                  elementClass(el),
                )}
              >
                <span aria-hidden>{el ? ELEMENT_SHORT[el] : ""}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="layout-plaetze">
          <strong>{seats}</strong> {seats === 1 ? "Platz" : "Plätze"} · {exam} Prüfungsplätze
          {variant === "pruefung" ? " (alle Plätze)" : " (jeder zweite Platz)"}
        </span>
        {hint && <span className="text-warn">{hint}</span>}
      </div>
      {fe.layout && (
        <p role="alert" className="text-sm text-danger">
          {fe.layout}
        </p>
      )}
      {result.error && !fe.layout && (
        <p role="alert" className="text-sm text-danger">
          {result.error}
        </p>
      )}
      {result.ok && (
        <p role="status" className="text-sm text-success">
          Layout gespeichert.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="primary" disabled={pending || !dirty} onClick={save}>
          {pending ? "Speichern …" : layoutId ? "Layout speichern" : "Layout anlegen"}
        </Button>
        {dirty && layoutId && <span className="text-sm text-warn">Nicht gespeichert</span>}
      </div>
    </section>
  );
}
