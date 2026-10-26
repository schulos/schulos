"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AssignmentImportState } from "@/modules/stundenplan/actions";
import type { ImportRowStatus } from "@/modules/stundenplan/verteilung-import";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Field, Input } from "@schulos/ui/field";
import { Table } from "@schulos/ui/table";

type Action = (prev: AssignmentImportState, form: FormData) => Promise<AssignmentImportState>;

const STATUS: Record<ImportRowStatus, { label: string; tone: "success" | "soft" | "neutral" | "danger" }> = {
  neu: { label: "neu", tone: "success" },
  aendern: { label: "ändern", tone: "soft" },
  gleich: { label: "unverändert", tone: "neutral" },
  fehler: { label: "Fehler", tone: "danger" },
};

/** SP2-06: Datei wählen → Vorschau mit Fehlern je Zeile → Übernehmen (nur ohne Fehler, ganz oder gar nicht). */
export function AssignmentImportForm({ preview, run }: { preview: Action; run: Action }) {
  const [checked, previewAction, checking] = useActionState(preview, {});
  const [result, runAction, running] = useActionState(run, {});
  // „Übernehmen“ prüft neu – hat das Fehler ergeben, zeigt die Vorschau diesen Stand
  const state = result.preview ? result : checked;
  const p = state.preview;

  if (result.done) {
    const d = result.done;
    return (
      <div role="status" className="flex flex-col gap-3 rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
        <p>
          Übernommen: {d.created === 1 ? "1 neuer Lehrauftrag" : `${d.created} neue Lehraufträge`}, {d.updated} geändert
          {d.bands ? `, ${d.bands === 1 ? "1 neues Band" : `${d.bands} neue Bänder`}` : ""}.
        </p>
        <p>
          <Link href="/planung/unterricht" className="font-medium underline">
            Zur Unterrichtsverteilung
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={previewAction} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="CSV-Datei" hint="Semikolon oder Komma, UTF-8 oder Windows-1252, höchstens 512 KB" error={checked.preview ? undefined : checked.error}>
          <Input type="file" name="file" accept=".csv,text/csv" required />
        </Field>
        <Button type="submit" disabled={checking}>
          {checking ? "Prüfe …" : "Prüfen (Vorschau)"}
        </Button>
      </form>

      {p && (
        <section aria-labelledby="vorschau" className="flex flex-col gap-3">
          <h2 id="vorschau" className="font-display text-xl font-bold">
            Vorschau
          </h2>
          <p className="text-sm text-muted">
            {p.counts.neu} neu · {p.counts.aendern} ändern · {p.counts.gleich} unverändert · {p.counts.fehler} mit Fehlern
            {p.newBands.length ? ` · neue Bänder: ${p.newBands.join(", ")}` : ""}
            {state.encoding === "cp1252" ? " · gelesen als Windows-1252" : ""}
          </p>
          {p.fileErrors.map((e) => (
            <p key={e} role="alert" className="text-sm text-danger">
              {e}
            </p>
          ))}
          {p.rows.length > 0 && (
            <Table scrollLabel="Vorschau des Imports">
              <thead>
                <tr>
                  <th className="text-right">Zeile</th>
                  <th>Klasse/Kurs</th>
                  <th>Fach</th>
                  <th className="text-right">Stunden</th>
                  <th>Lehrkraft</th>
                  <th className="text-right">Doppelst.</th>
                  <th>Raum</th>
                  <th>Band</th>
                  <th>gültig ab</th>
                  <th>gültig bis</th>
                  <th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r) => (
                  <tr key={r.line}>
                    <td className="text-right tabular-nums">{r.line}</td>
                    <td>{r.group}</td>
                    <td>{r.subject}</td>
                    <td className="text-right tabular-nums">{r.hours}</td>
                    <td>{r.teachers || "–"}</td>
                    <td className="text-right tabular-nums">{r.doubles}</td>
                    <td>{r.room}</td>
                    <td>{r.band}</td>
                    <td className="tabular-nums">{r.validFrom}</td>
                    <td className="tabular-nums">{r.validUntil}</td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                        {r.notes.map((n) => (
                          <span key={n} className={r.status === "fehler" ? "text-xs text-danger" : "text-xs text-muted"}>
                            {n}
                          </span>
                        ))}
                        {r.warnings.map((n) => (
                          <span key={n} className="text-xs text-warn">
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
          <form action={runAction} className="flex flex-col gap-2">
            <input type="hidden" name="text" value={state.text ?? ""} />
            <input type="hidden" name="encoding" value={state.encoding ?? "utf8"} />
            {result.error && (
              <p role="alert" className="text-sm text-danger">
                {result.error}
              </p>
            )}
            {!p.ok && (
              <p className="text-sm text-muted">
                {p.counts.fehler || p.fileErrors.length ? "Erst die Fehler in der Datei beheben und neu prüfen – übernommen wird nur eine fehlerfreie Datei." : "Nichts zu übernehmen."}
              </p>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={!p.ok || running}>
                {running ? "Übernehme …" : p.counts.neu + p.counts.aendern === 1 ? "1 Lehrauftrag übernehmen" : `${p.counts.neu + p.counts.aendern} Lehraufträge übernehmen`}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
