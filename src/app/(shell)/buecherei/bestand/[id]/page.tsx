import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addCopiesAction, deleteTitleAction, restoreCopyAction, updateCopyAction, updateTitleAction, withdrawCopyAction } from "@/modules/buecherei/actions";
import { CONDITION_LABELS, COPY_CONDITIONS, MEDIA_TYPE_LABELS, MEDIA_TYPES, formatIsbn } from "@/modules/buecherei/labels";
import { MAX_COPIES_AT_ONCE, canStock, getTitle } from "@/modules/buecherei/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";

export const metadata: Metadata = { title: "Titel im Bestand" };

const MEDIA_OPTIONS = MEDIA_TYPES.map((k) => ({ value: k, label: MEDIA_TYPE_LABELS[k] }));
const CONDITION_OPTIONS = COPY_CONDITIONS.map((k) => ({ value: k, label: CONDITION_LABELS[k] }));
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/** Ein Titel mit seinen Exemplaren (BU-01): Angaben ändern, Exemplare anlegen, bearbeiten, aussondern. */
export default async function TitelPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  if (!canStock(perms)) notFound();
  const { id } = await params;
  const data = await getTitle(await getDb(), perms, id);
  if (!data) notFound();
  const { title: t, copies } = data;
  const active = copies.filter((c) => !c.withdrawnOn);
  const s = (v: string | number | null) => (v === null ? "" : String(v));

  return (
    <main className="flex flex-col gap-6">
      <Link href="/buecherei/bestand" className="text-sm font-medium text-accent-ink hover:underline">
        ← Bestand
      </Link>
      <PageHeader eyebrow={`Bücherei · ${MEDIA_TYPE_LABELS[t.mediaType]}`} title={t.title} />
      <p className="text-sm text-muted">
        {[t.author, t.publisher, t.year, t.isbn ? `ISBN ${formatIsbn(t.isbn)}` : null].filter(Boolean).join(" · ") || "ohne weitere Angaben"} · {active.length} von {copies.length}{" "}
        Exemplaren im Bestand
      </p>

      <Card aria-labelledby="exemplare">
        <CardHeader title={<span id="exemplare">Exemplare</span>} />
        {copies.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Exemplare.</p>
        ) : (
          <Table>
            <caption className="sr-only">Exemplare von {t.title}</caption>
            <thead>
              <tr>
                <th>Exemplarnummer</th>
                <th>Signatur</th>
                <th>Standort</th>
                <th>Zustand</th>
                <th className="sr-only">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {copies.map((c) => (
                <tr key={c.id}>
                  <td className="font-mono tabular-nums">
                    {c.barcode}
                    {c.withdrawnOn && (
                      <Badge tone="neutral" className="ml-2">
                        ausgesondert {day(c.withdrawnOn)}
                      </Badge>
                    )}
                    {c.withdrawnReason && <span className="block text-xs text-muted">{c.withdrawnReason}</span>}
                  </td>
                  <td>{c.signature ?? "–"}</td>
                  <td>{c.location ?? "–"}</td>
                  <td>{CONDITION_LABELS[c.condition]}</td>
                  <td className="text-right">
                    {c.withdrawnOn ? (
                      <form action={restoreCopyAction.bind(null, c.id)}>
                        <Button type="submit" size="sm" variant="ghost" aria-label={`${c.barcode} wieder in den Bestand`}>
                          zurück in den Bestand
                        </Button>
                      </form>
                    ) : (
                      <details className="text-left">
                        <summary className="cursor-pointer text-sm font-medium text-accent-ink">ändern / aussondern</summary>
                        <div className="mt-3 flex min-w-72 flex-col gap-4">
                          <SpecForm
                            action={updateCopyAction.bind(null, c.id)}
                            label={`Exemplar ${c.barcode} ändern`}
                            submit="Speichern"
                            okText="Gespeichert."
                            columns={1}
                            variant="secondary"
                            fields={[
                              { name: "signature", label: "Signatur", type: "text", maxLength: 40, defaultValue: s(c.signature) },
                              { name: "location", label: "Standort", type: "text", maxLength: 80, defaultValue: s(c.location) },
                              { name: "condition", label: "Zustand", type: "select", options: CONDITION_OPTIONS, defaultValue: c.condition },
                            ]}
                          />
                          <SpecForm
                            action={withdrawCopyAction.bind(null, c.id)}
                            label={`Exemplar ${c.barcode} aussondern`}
                            submit="Aussondern"
                            columns={1}
                            variant="secondary"
                            fields={[{ name: "reason", label: "Grund", type: "text", required: true, maxLength: 200, placeholder: "z. B. beschädigt, verloren, veraltet" }]}
                          />
                        </div>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <SpecForm
          action={addCopiesAction.bind(null, t.id)}
          label="Exemplare hinzufügen"
          submit="Exemplare hinzufügen"
          columns={3}
          variant="secondary"
          fields={[
            { name: "count", label: "Anzahl", type: "number", min: 1, max: MAX_COPIES_AT_ONCE, defaultValue: "1" },
            { name: "signature", label: "Signatur", type: "text", maxLength: 40, defaultValue: s(copies.at(-1)?.signature ?? null) },
            { name: "location", label: "Standort", type: "text", maxLength: 80, defaultValue: s(copies.at(-1)?.location ?? null) },
            { name: "condition", label: "Zustand", type: "select", options: CONDITION_OPTIONS, defaultValue: "neu" },
          ]}
        />
      </Card>

      <Card aria-labelledby="angaben">
        <CardHeader title={<span id="angaben">Angaben zum Titel</span>} />
        <SpecForm
          action={updateTitleAction.bind(null, t.id)}
          label="Titel ändern"
          submit="Speichern"
          okText="Gespeichert."
          fields={[
            { name: "title", label: "Titel", type: "text", required: true, maxLength: 200, wide: true, defaultValue: t.title },
            { name: "author", label: "Autor:in", type: "text", maxLength: 120, defaultValue: s(t.author) },
            { name: "isbn", label: "ISBN", type: "text", maxLength: 20, defaultValue: s(t.isbn) },
            { name: "mediaType", label: "Medienart", type: "select", options: MEDIA_OPTIONS, defaultValue: t.mediaType },
            { name: "publisher", label: "Verlag", type: "text", maxLength: 120, defaultValue: s(t.publisher) },
            { name: "year", label: "Jahr", type: "number", min: 1450, max: 2100, defaultValue: s(t.year) },
            { name: "ageFrom", label: "Altersempfehlung ab", type: "number", min: 0, max: 21, hint: "Jahre", defaultValue: s(t.ageFrom) },
            { name: "keywords", label: "Schlagwörter", type: "text", maxLength: 300, wide: true, defaultValue: s(t.keywords) },
            { name: "note", label: "Bemerkung", type: "textarea", maxLength: 500, wide: true, defaultValue: s(t.note), hint: "keine Personennamen" },
          ]}
        />
      </Card>

      {copies.length === 0 && (
        <Card aria-labelledby="loeschen">
          <CardHeader title={<span id="loeschen">Titel löschen</span>} />
          <p className="text-sm text-muted">Nur Titel ohne Exemplare lassen sich löschen (z. B. nach einer Fehlerfassung). Bestand wird ausgesondert, nicht gelöscht.</p>
          <SpecForm action={deleteTitleAction.bind(null, t.id)} label="Titel löschen" submit="Titel löschen" columns={1} variant="secondary" fields={[]} />
        </Card>
      )}
    </main>
  );
}
