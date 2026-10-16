import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { TZ, toBerlinDate } from "@/core/time";
import { INSPECTION_STATE_LABELS, RESPONSIBLE_LABELS, RESULT_LABELS } from "@/modules/gebaeude/labels";
import { checklist, formatDay, inspectionBuildings, listInspectionTypes, type ChecklistRow } from "@/modules/gebaeude/pruefungen";
import { canViewAll } from "@/modules/gebaeude/service";
import { Button } from "@schulos/ui/button";
import { Field, Select } from "@schulos/ui/field";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Prüfliste drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });

/** P4-18: Prüfliste je Gebäude/Prüfart als Nachweis für den Schulträger – letzte Prüfung (Datum, Ergebnis, Firma) und nächste Fälligkeit. */
export default async function PrueflisteDruckPage({ searchParams }: { searchParams: Promise<{ gebaeude?: string; art?: string }> }) {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  if (!canViewAll(perms)) notFound();
  const db = await getDb();
  const sp = await searchParams;
  const [types, buildings] = await Promise.all([listInspectionTypes(db), inspectionBuildings(db)]);
  const type = types.find((t) => t.id === sp.art);
  const building = buildings.find((b) => b === sp.gebaeude);
  const today = toBerlinDate(new Date());
  const rows = await checklist(db, perms, { building, typeId: type?.id }, today);
  const groups = new Map<string, ChecklistRow[]>();
  for (const r of rows) groups.set(r.typeId, [...(groups.get(r.typeId) ?? []), r]);

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/gebaeude/pruefungen">Zurück zu den Prüfungen</Link>
        </Button>
        <form aria-label="Auswahl" className="flex flex-wrap items-end gap-2">
          <Field label="Gebäude">
            <Select name="gebaeude" defaultValue={building ?? ""} className="w-48">
              <option value="">alle</option>
              {buildings.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </Select>
          </Field>
          <Field label="Prüfart">
            <Select name="art" defaultValue={type?.id ?? ""} className="w-72">
              <option value="">alle</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" size="sm">
            Anzeigen
          </Button>
        </form>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-5">
        <DruckKopf
          eyebrow="Gebäude & Technik"
          title="Prüfliste"
          subtitle={[building ?? "alle Gebäude", type?.name ?? "alle Prüfarten"].join(" · ")}
          stamp={`Stand ${stamp.format(new Date())}`}
        />
        {rows.length === 0 ? (
          <p className="text-sm">Keine Prüfungen für diese Auswahl.</p>
        ) : (
          [...groups.values()].map((list) => (
            <section key={list[0]!.typeId} aria-label={list[0]!.typeName} className="flex flex-col gap-1 break-inside-avoid">
              <h2 className="font-display text-lg font-bold">{list[0]!.typeName}</h2>
              <p className="text-xs">
                Intervall {list[0]!.intervalMonths} Monate · zuständig: {RESPONSIBLE_LABELS[list[0]!.responsible]}
                {list[0]!.source && ` · Quelle: ${list[0]!.source}`}
              </p>
              <table className="w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-border-strong [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border-strong [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs">
                <thead>
                  <tr>
                    <th>Gegenstand</th>
                    <th>Ort</th>
                    <th>letzte Prüfung</th>
                    <th>Ergebnis</th>
                    <th>Firma</th>
                    <th>nächste Fälligkeit</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.key} className="break-inside-avoid">
                      <td>{r.target}</td>
                      <td>{[r.roomId ? `Raum ${r.roomId}` : null, r.building].filter(Boolean).join(" · ") || "–"}</td>
                      <td>{r.last ? formatDay(r.last.doneOn) : "–"}</td>
                      <td>{r.last ? (r.last.result ? RESULT_LABELS[r.last.result] : "übernommen") : "–"}</td>
                      <td>{r.last?.company ?? "–"}</td>
                      <td>
                        {r.next ? (
                          <>
                            {formatDay(r.next.dueOn)}
                            {r.next.state !== "geplant" && <strong> ({INSPECTION_STATE_LABELS[r.next.state]})</strong>}
                          </>
                        ) : (
                          "–"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
        <p className="text-xs">
          Fristen und Quellen sind eine Vorlage zum Prüfen – maßgeblich sind die Vorgaben von Schulträger und Fachkraft für Arbeitssicherheit. Erstellt mit SchulOS.
        </p>
      </main>
    </div>
  );
}
