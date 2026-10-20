import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import {
  addMaterialCopiesAction,
  archiveMaterialAction,
  deleteMaterialAction,
  restoreMaterialCopyAction,
  updateMaterialAction,
  updateMaterialCopyAction,
  withdrawMaterialCopyAction,
} from "@/modules/buecherei/actions";
import { CONDITION_LABELS, PROVISION_LABELS, formatEuro, formatIsbn, gradeRange } from "@/modules/buecherei/labels";
import { MAX_MATERIAL_COPIES_AT_ONCE, canMaterials, getMaterial, lernmittelEnabled, materialChoices } from "@/modules/buecherei/lernmittel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { SpecForm } from "@/ui/spec-form";
import { CONDITION_OPTIONS, materialFields } from "../material-fields";

export const metadata: Metadata = { title: "Lernmittel" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/** Ein Lernmittel (BU-10): Angaben, Jahrgänge, Exemplare mit Inventarnummer und Zustand, archivieren. */
export default async function LernmittelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canMaterials(perms) || !(await lernmittelEnabled(db))) notFound();
  const { id } = await params;
  const [data, choices] = await Promise.all([getMaterial(db, perms, id), materialChoices(db)]);
  if (!data) notFound();
  const { material: m, copies } = data;
  const active = copies.filter((c) => !c.withdrawnOn);
  const s = (v: string | number | null) => (v === null ? "" : String(v));

  return (
    <main className="flex flex-col gap-6">
      <Link href="/buecherei/lernmittel" className="text-sm font-medium text-accent-ink hover:underline">
        ← Lernmittel
      </Link>
      <PageHeader eyebrow={`Lernmittel · Jahrgang ${gradeRange(m.grades)}${m.subjectName ? ` · ${m.subjectName}` : ""}`} title={m.title} />
      <p className="text-sm text-muted">
        {[m.publisher, m.isbn ? `ISBN ${formatIsbn(m.isbn)}` : null, m.course, PROVISION_LABELS[m.provision], m.priceCents != null ? formatEuro(m.priceCents) : null].filter(Boolean).join(" · ")}
        {m.provision === "leihe" && ` · ${active.length} von ${copies.length} Exemplaren im Bestand`}
        {m.archivedOn && (
          <Badge tone="neutral" className="ml-2">
            archiviert {day(m.archivedOn)}
          </Badge>
        )}
      </p>

      {m.provision === "leihe" && (
        <Card aria-labelledby="exemplare">
          <CardHeader
            title={<span id="exemplare">Exemplare</span>}
            action={active.length > 0 ? { href: `/druck/buecherei-etiketten?lernmittel=${m.id}`, label: "Etiketten drucken" } : undefined}
          />
          {copies.length === 0 ? (
            <p className="text-sm text-muted">Noch keine Exemplare.</p>
          ) : (
            <Table>
              <caption className="sr-only">Exemplare von {m.title}</caption>
              <thead>
                <tr>
                  <th>Inventarnummer</th>
                  <th>Zustand</th>
                  <th>angeschafft</th>
                  <th className="sr-only">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {copies.map((c) => (
                  <tr key={c.id}>
                    <td className="font-mono tabular-nums">
                      <span>{c.inventoryNumber}</span>
                      {c.withdrawnOn && (
                        <Badge tone="neutral" className="ml-2">
                          ausgesondert {day(c.withdrawnOn)}
                        </Badge>
                      )}
                      {c.withdrawnReason && <span className="block font-sans text-xs text-muted">{c.withdrawnReason}</span>}
                    </td>
                    <td>
                      {CONDITION_LABELS[c.condition]}
                      {c.conditionNote && <span className="block text-xs text-muted">{c.conditionNote}</span>}
                    </td>
                    <td className="tabular-nums">{c.acquiredYear ?? "–"}</td>
                    <td className="text-right">
                      {c.withdrawnOn ? (
                        <form action={restoreMaterialCopyAction.bind(null, c.id)}>
                          <Button type="submit" size="sm" variant="ghost" aria-label={`${c.inventoryNumber} wieder in den Bestand`}>
                            zurück in den Bestand
                          </Button>
                        </form>
                      ) : (
                        <details className="text-left">
                          <summary className="cursor-pointer text-sm font-medium text-accent-ink">Zustand / aussondern</summary>
                          <div className="mt-3 flex min-w-72 flex-col gap-4">
                            <Button asChild size="sm" variant="secondary" className="self-start">
                              <Link href={`/druck/buecherei-etiketten?lernmittel-exemplar=${c.id}&vorlage=rolle-62x29`} aria-label={`Etikett ${c.inventoryNumber} drucken`}>
                                Etikett drucken
                              </Link>
                            </Button>
                            <SpecForm
                              action={updateMaterialCopyAction.bind(null, c.id)}
                              label={`Exemplar ${c.inventoryNumber} ändern`}
                              submit="Speichern"
                              okText="Gespeichert."
                              columns={1}
                              variant="secondary"
                              fields={[
                                { name: "condition", label: "Zustand", type: "select", options: CONDITION_OPTIONS, defaultValue: c.condition },
                                { name: "conditionNote", label: "Vermerk", type: "text", maxLength: 200, defaultValue: s(c.conditionNote), hint: "zur Sache, keine Namen" },
                                { name: "acquiredYear", label: "angeschafft", type: "number", min: 1990, max: 2100, defaultValue: s(c.acquiredYear) },
                              ]}
                            />
                            <SpecForm
                              action={withdrawMaterialCopyAction.bind(null, c.id)}
                              label={`Exemplar ${c.inventoryNumber} aussondern`}
                              submit="Aussondern"
                              columns={1}
                              variant="secondary"
                              fields={[{ name: "reason", label: "Grund", type: "text", required: true, maxLength: 200, placeholder: "z. B. verschlissen, alte Auflage, verloren" }]}
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
            action={addMaterialCopiesAction.bind(null, m.id)}
            label="Exemplare hinzufügen"
            submit="Exemplare hinzufügen"
            columns={3}
            variant="secondary"
            fields={[
              { name: "count", label: "Anzahl", type: "number", min: 1, max: MAX_MATERIAL_COPIES_AT_ONCE, defaultValue: "1" },
              { name: "condition", label: "Zustand", type: "select", options: CONDITION_OPTIONS, defaultValue: "neu" },
              { name: "acquiredYear", label: "angeschafft", type: "number", min: 1990, max: 2100, defaultValue: String(new Date().getFullYear()) },
            ]}
          />
        </Card>
      )}

      <Card aria-labelledby="angaben">
        <CardHeader title={<span id="angaben">Angaben zum Lernmittel</span>} />
        <SpecForm action={updateMaterialAction.bind(null, m.id)} label="Lernmittel ändern" submit="Speichern" okText="Gespeichert." fields={materialFields(choices, m)} />
      </Card>

      <Card aria-labelledby="archiv">
        <CardHeader title={<span id="archiv">{m.archivedOn ? "Archiviert" : "Archivieren"}</span>} />
        <p className="text-sm text-muted">
          {m.archivedOn
            ? "Archivierte Lernmittel stehen auf keiner Bücherliste; ihre Exemplare bleiben im Bestand."
            : "Nicht mehr verwendet (z. B. neue Auflage)? Archivieren nimmt das Lernmittel von den Bücherlisten, die Exemplare bleiben im Bestand."}
        </p>
        <SpecForm
          action={archiveMaterialAction.bind(null, m.id, !m.archivedOn)}
          label={m.archivedOn ? "Lernmittel wieder aktivieren" : "Lernmittel archivieren"}
          submit={m.archivedOn ? "Wieder aktivieren" : "Archivieren"}
          columns={1}
          variant="secondary"
          fields={[]}
        />
        {copies.length === 0 && (
          <SpecForm action={deleteMaterialAction.bind(null, m.id)} label="Lernmittel löschen" submit="Löschen (Fehlerfassung)" columns={1} variant="secondary" fields={[]} />
        )}
      </Card>
    </main>
  );
}
