import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { DEFAULT_EXPORT_COLUMNS, EXPORT_COLUMNS, EXPORT_SCOPES, EXPORT_SCOPE_LABELS } from "@/modules/anmeldung/entscheidung";
import { canDecide, canManage, getVerfahren } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { PageHeader } from "@schulos/ui/misc";
import { VerfahrenNav } from "../../shared";

export const metadata: Metadata = { title: "Export" };
export const dynamic = "force-dynamic";

function EncodingField() {
  return (
    <Field label="Kodierung" hint="Ältere Programme unter Windows erwarten oft Windows-1252 (ANSI)">
      <Select name="encoding" defaultValue="utf8" className="w-64">
        <option value="utf8">UTF-8 (mit BOM)</option>
        <option value="cp1252">Windows-1252 (ANSI)</option>
      </Select>
    </Field>
  );
}

/**
 * Export (P4-37): CSV für die Schulverwaltungssoftware (Spaltenwahl, Kodierung, Auswahl der Anträge) und Serienbrief-CSV
 * für die Bescheide. Formulare per POST an `/api/verwaltung/anmeldung-export/…` (SEC-05: kein Export per Link); jeder Export im Protokoll.
 */
export default async function ExportPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const manage = canManage(perms);
  const letters = manage || canDecide(perms);
  const action = (art: string) => `/api/verwaltung/anmeldung-export/${encodeURIComponent(v.id)}/${art}`;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title={v.name} />
      <VerfahrenNav id={v.id} current="export" />
      <p className="max-w-3xl text-sm text-muted">
        SchulOS ist nicht das führende Verwaltungssystem: Aufgenommene Kinder werden in die Schulverwaltungssoftware übernommen, die
        Bescheide schreibt die Schule per Serienbrief. Beide Exporte enthalten personenbezogene Daten – Datei nach dem Einlesen löschen.
        Jeder Export wird protokolliert.
      </p>
      {manage ? (
        <Card aria-label="Export Schulverwaltungssoftware">
          <CardHeader title="CSV für die Schulverwaltungssoftware" />
          <form method="post" action={action("svs")} className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Spalten (in dieser Reihenfolge)</legend>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {EXPORT_COLUMNS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="col" value={c.key} defaultChecked={DEFAULT_EXPORT_COLUMNS.includes(c.key)} className="size-4 accent-[var(--accent)]" />
                    {c.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Anträge">
                <Select name="scope" defaultValue="aufgenommen" className="w-80">
                  {EXPORT_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {EXPORT_SCOPE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <EncodingField />
              <Button type="submit" variant="primary">
                CSV herunterladen
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
      {letters && (
        <Card aria-label="Serienbrief">
          <CardHeader title="Serienbrief für die Bescheide" />
          <p className="text-sm text-muted">
            Je entschiedenem Antrag: Vorgangsnummer, Entscheidung, Empfänger mit Anschrift, Kind mit Geburtsdatum, Datum der Entscheidung –
            für die Serienbrief-Funktion der Textverarbeitung. Ablehnungen brauchen eine Rechtsbehelfsbelehrung (Vorlage der Schule).
          </p>
          <form method="post" action={action("serienbrief")} className="flex flex-wrap items-end gap-3">
            <EncodingField />
            <Button type="submit">Serienbrief-CSV herunterladen</Button>
          </form>
        </Card>
      )}
    </main>
  );
}
