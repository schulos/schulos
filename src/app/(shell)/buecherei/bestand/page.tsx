import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { createTitleAction, importTitlesAction } from "@/modules/buecherei/actions";
import { MEDIA_TYPE_LABELS, MEDIA_TYPES, formatIsbn, type MediaType } from "@/modules/buecherei/labels";
import { MAX_COPIES_AT_ONCE, canStock, listTitles, stockSummary } from "@/modules/buecherei/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";

export const metadata: Metadata = { title: "Bücherei-Bestand" };

type Search = { q?: string; art?: string; alle?: string };

const MEDIA_OPTIONS = MEDIA_TYPES.map((k) => ({ value: k, label: MEDIA_TYPE_LABELS[k] }));

/** Bestand der Schulbücherei (BU-01, Recht `buecherei.stock`): Suche, Titel anlegen, Altbestand per CSV importieren. */
export default async function BestandPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!canStock(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const mediaType = MEDIA_TYPES.find((k): k is MediaType => k === sp.art);
  const q = sp.q?.trim() ?? "";
  const [titles, sum] = await Promise.all([listTitles(db, perms, { q, mediaType, withdrawn: sp.alle === "1" }), stockSummary(db, perms)]);
  const filtered = !!(q || mediaType);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Bestand" />
      <p className="text-sm text-muted">
        {sum.titles} Titel · {sum.copies} Exemplare im Bestand{sum.withdrawn > 0 && ` · ${sum.withdrawn} ausgesondert`}
      </p>

      <form aria-label="Bestand durchsuchen" className="flex flex-wrap items-end gap-3">
        <Field label="Suche" hint="Titel, Autor:in, ISBN, Schlagwort oder Exemplarnummer">
          <Input type="search" name="q" defaultValue={q} maxLength={100} className="w-72" />
        </Field>
        <Field label="Medienart">
          <Select name="art" defaultValue={mediaType ?? ""} className="w-40">
            <option value="">alle</option>
            {MEDIA_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="alle" value="1" defaultChecked={sp.alle === "1"} className="size-4 accent-[var(--accent)]" />
          auch ganz ausgesonderte Titel
        </label>
        <Button type="submit">Suchen</Button>
      </form>

      {titles.length === 0 ? (
        <EmptyState title={filtered ? "Nichts gefunden" : "Noch kein Bestand"}>
          {filtered ? "Andere Suchbegriffe versuchen." : "Unten einzelne Titel anlegen oder den Altbestand als CSV importieren."}
        </EmptyState>
      ) : (
        <Table>
          <caption className="sr-only">Titel im Bestand</caption>
          <thead>
            <tr>
              <th>Titel</th>
              <th>Autor:in</th>
              <th>Medienart</th>
              <th>ISBN</th>
              <th className="text-right">Exemplare</th>
            </tr>
          </thead>
          <tbody>
            {titles.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">
                  <Link href={`/buecherei/bestand/${t.id}`} className="hover:underline">
                    {t.title}
                  </Link>
                  {t.year && <span className="text-muted"> ({t.year})</span>}
                </td>
                <td>{t.author ?? "–"}</td>
                <td>{MEDIA_TYPE_LABELS[t.mediaType]}</td>
                <td className="tabular-nums">{t.isbn ? formatIsbn(t.isbn) : "–"}</td>
                <td className="text-right tabular-nums">
                  {t.active}
                  {t.copies > t.active && (
                    <Badge tone="neutral" className="ml-2">
                      {t.copies - t.active} ausgesondert
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="titel-anlegen">
          <CardHeader title={<span id="titel-anlegen">Titel anlegen</span>} />
          <SpecForm
            action={createTitleAction}
            label="Titel anlegen"
            submit="Anlegen"
            fields={[
              { name: "title", label: "Titel", type: "text", required: true, maxLength: 200, wide: true },
              { name: "author", label: "Autor:in", type: "text", maxLength: 120 },
              { name: "isbn", label: "ISBN", type: "text", maxLength: 20, hint: "ISBN-10 oder -13, Prüfziffer wird geprüft" },
              { name: "mediaType", label: "Medienart", type: "select", options: MEDIA_OPTIONS, defaultValue: "buch" },
              { name: "publisher", label: "Verlag", type: "text", maxLength: 120 },
              { name: "year", label: "Jahr", type: "number", min: 1450, max: 2100 },
              { name: "ageFrom", label: "Altersempfehlung ab", type: "number", min: 0, max: 21, hint: "Jahre" },
              { name: "keywords", label: "Schlagwörter", type: "text", maxLength: 300, wide: true, hint: "durch Komma getrennt" },
              { name: "count", label: "Exemplare", type: "number", min: 0, max: MAX_COPIES_AT_ONCE, defaultValue: "1", hint: "Exemplarnummern vergibt SchulOS" },
              { name: "signature", label: "Signatur", type: "text", maxLength: 40 },
              { name: "location", label: "Standort", type: "text", maxLength: 80, wide: true, placeholder: "z. B. Regal 3, Jugendbuch" },
            ]}
          />
        </Card>
        <Card aria-labelledby="import">
          <CardHeader title={<span id="import">Altbestand importieren (CSV)</span>} />
          <p className="text-sm text-muted">
            Spalten <code>Titel;Autor;ISBN;Verlag;Jahr;Medienart;Signatur;Standort;Exemplare</code> – mit oder ohne Kopfzeile, Trennzeichen „;“ oder „,“.
            Ohne Angabe ein Exemplar je Zeile. Gleiche ISBN wie ein vorhandener Titel → nur weitere Exemplare. Fehler in einer Zeile → nichts wird übernommen.
          </p>
          <SpecForm
            action={importTitlesAction}
            label="Altbestand importieren"
            submit="Importieren"
            columns={1}
            fields={[
              { name: "file", label: "CSV-Datei", type: "file", accept: ".csv,text/csv", hint: "höchstens 1 MB, 5000 Zeilen" },
              { name: "dryRun", label: "nur prüfen (Vorschau, nichts übernehmen)", type: "checkbox", checked: true },
            ]}
          />
        </Card>
      </div>
    </main>
  );
}
