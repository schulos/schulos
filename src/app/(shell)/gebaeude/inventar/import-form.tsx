"use client";

import { useActionState } from "react";
import type { AssetImportState } from "@/modules/gebaeude/actions";
import type { ImportStatus } from "@/modules/gebaeude/inventar-csv";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Input, Select } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

type Action = (prev: AssetImportState, form: FormData) => Promise<AssetImportState>;

const STATUS: Record<ImportStatus, { label: string; tone: "success" | "soft" | "neutral" | "warn" | "danger" }> = {
  neu: { label: "neu", tone: "success" },
  aendern: { label: "ändern", tone: "soft" },
  gleich: { label: "unverändert", tone: "neutral" },
  uebersprungen: { label: "übersprungen", tone: "warn" },
  fehler: { label: "Fehler", tone: "danger" },
};

/** Höchstens so viele Zeilen in der Vorschau-Tabelle (unveränderte nur als Zahl). */
const SHOW_ROWS = 300;

/**
 * INV-06: Datei wählen → Vorschau (Trockenlauf) mit Spaltenzuordnung und Ergebnis je Zeile → Übernehmen (nur ohne Fehler,
 * ganz oder gar nicht). Die Datei bleibt bis zur Übernahme im Formular; der Server prüft beim Übernehmen erneut.
 */
export function AssetImportForm({ preview, run, fields }: { preview: Action; run: Action; fields: { value: string; label: string }[] }) {
  const [checked, previewAction, checking] = useActionState(preview, {});
  const [result, runAction, running] = useActionState(run, {});
  const state = result.preview ? result : checked;
  const p = state.preview;

  if (result.done) {
    const d = result.done;
    return (
      <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
        Übernommen: {d.created} angelegt, {d.updated} aktualisiert{d.skipped ? `, ${d.skipped} unverändert bzw. übersprungen` : ""}.
      </p>
    );
  }

  const shown = p ? p.rows.filter((r) => r.status !== "gleich").slice(0, SHOW_ROWS) : [];
  return (
    <div className="flex flex-col gap-4">
      <form action={previewAction} className="flex flex-col gap-3">
        <Field label="CSV-Datei" hint="Semikolon oder Komma, UTF-8 oder Windows-1252, höchstens 512 KB und 2000 Zeilen" error={checked.preview ? undefined : checked.error}>
          <Input type="file" name="file" accept=".csv,text/csv" required />
        </Field>
        <div>
          <Button type="submit" disabled={checking}>
            {checking ? "Prüfe …" : "Prüfen (Vorschau)"}
          </Button>
        </div>
      </form>
      {p && (
        <section aria-labelledby="import-vorschau" className="flex flex-col gap-3">
          <h3 id="import-vorschau" className="font-display text-lg font-bold">
            Vorschau – noch nichts gespeichert
          </h3>
          <p role="status" className="text-sm text-muted">
            {p.counts.neu} neu · {p.counts.aendern} ändern · {p.counts.gleich} unverändert · {p.counts.uebersprungen} übersprungen · {p.counts.fehler} mit Fehlern
          </p>
          {p.fileErrors.map((e) => (
            <p key={e} role="alert" className="text-sm text-danger">
              {e}
            </p>
          ))}
          {/* key: nach jeder Prüfung neu aufbauen – React setzt das Formular nach der Action zurück, sonst fiele die gewählte
              Zuordnung beim Übernehmen auf die erste Erkennung zurück */}
          <form key={JSON.stringify(p.layout)} className="flex flex-col gap-3">
            <input type="hidden" name="text" value={state.text ?? ""} />
            <input type="hidden" name="zuordnung" value="1" />
            <details className="rounded-xl border border-border px-3 py-2" open={p.counts.fehler > 0 && p.counts.neu + p.counts.aendern === 0}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Spaltenzuordnung</summary>
              <div className="flex flex-col gap-3 pb-2 pt-1">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" name="kopfzeile" value="1" defaultChecked={p.layout.header} className="size-6 accent-[var(--accent)]" />
                  Erste Zeile ist Kopfzeile
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {p.layout.columns.map((c, i) => (
                    <Field key={i} label={`Spalte ${i + 1}${p.firstCells[i] ? `: „${p.firstCells[i]}“` : ""}`}>
                      <Select name={`spalte${i}`} defaultValue={c ?? ""}>
                        <option value="">– nicht übernehmen –</option>
                        {fields.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ))}
                </div>
                <div>
                  <Button type="submit" variant="secondary" formAction={previewAction} disabled={checking}>
                    Mit dieser Zuordnung neu prüfen
                  </Button>
                </div>
              </div>
            </details>
            {shown.length > 0 && (
              <Table scrollLabel="Vorschau des Imports">
                <caption className="sr-only">Vorschau des Imports</caption>
                <thead>
                  <tr>
                    <th className="text-right">Zeile</th>
                    <th>Inventarnr.</th>
                    <th>Bezeichnung</th>
                    <th>Ergebnis</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.line}>
                      <td className="text-right tabular-nums">{r.line}</td>
                      <td className="font-mono">{r.inventoryNo ?? "–"}</td>
                      <td>
                        {r.name || "–"}
                        {r.category && <span className="block text-xs text-muted">{r.category}</span>}
                      </td>
                      <td>
                        <div className="flex flex-col gap-1">
                          <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                          {r.notes.map((n) => (
                            <span key={n} className={r.status === "fehler" ? "text-xs text-danger" : "text-xs text-muted"}>
                              {n}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {p.rows.filter((r) => r.status !== "gleich").length > SHOW_ROWS && <p className="text-xs text-muted">Es werden die ersten {SHOW_ROWS} Zeilen gezeigt.</p>}
            {result.error && (
              <p role="alert" className="text-sm text-danger">
                {result.error}
              </p>
            )}
            {!p.ok && <p className="text-sm text-muted">{p.counts.fehler || p.fileErrors.length ? "Erst die Fehler beheben (Datei oder Zuordnung) und neu prüfen." : "Nichts zu übernehmen."}</p>}
            <div>
              <Button type="submit" variant="primary" formAction={runAction} disabled={!p.ok || running}>
                {running ? "Übernehme …" : `${p.counts.neu + p.counts.aendern} ${p.counts.neu + p.counts.aendern === 1 ? "Eintrag" : "Einträge"} übernehmen`}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
