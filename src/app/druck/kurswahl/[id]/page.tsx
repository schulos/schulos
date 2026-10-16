import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { selfResponsibleIds } from "@/core/school/majority";
import { TZ } from "@/core/time";
import { KIND_LABEL, MANAGE, getVerfahren, getWahlPlaces, listAngebote, neededChoices, rankLabel, roleFor, targetStudents } from "@/modules/kurswahl/service";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Wahlbogen drucken" };

const stamp = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));

/**
 * P4-62: Wahlbogen zur Unterschrift – je Schüler:in eine Seite mit den Wünschen (abgegeben oder leer zum Ausfüllen).
 * Familien drucken nur den eigenen (`?schueler=`), die Verwaltung einen oder alle der Zielgruppe.
 */
export default async function KurswahlDruckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ schueler?: string }> }) {
  await requireModulePage("kurswahl");
  const { perms } = await requireUser();
  const db = await getDb();
  const v = await getVerfahren(db, (await params).id);
  if (!v) notFound();
  const { schueler } = await searchParams;
  const manage = hasPermission(perms, MANAGE);
  const target = await targetStudents(db, v);
  const students = schueler ? target.filter((t) => t.id === schueler) : manage ? target : [];
  if (!manage) {
    if (!schueler || !(await roleFor(db, perms, v, schueler))) notFound();
  }
  if (students.length === 0) notFound();
  const offers = await listAngebote(db, v.id);
  const title = new Map(offers.map((o) => [o.id, o.title]));
  const need = neededChoices(v, offers.length);
  const self = await selfResponsibleIds(
    db,
    students.map((s) => s.id),
  );
  // P4-67: alle Plätze je Person (bei einem Kurs je Person genau einer)
  const wahlen = new Map(await Promise.all(students.map(async (s) => [s.id, await getWahlPlaces(db, v.id, s.id)] as const)));
  const multi = v.maxCourses > 1;

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-end gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={manage && !schueler ? `/kurswahl/${v.id}` : "/kurswahl"}>Zurück</Link>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[190mm] flex-col gap-8">
        {students.map((s) => {
          const places = wahlen.get(s.id) ?? [];
          const at = (place: number, i: number) => {
            const w = places.find((x) => x.place === place);
            return w?.submittedAt && w.choices[i] ? title.get(w.choices[i]!) : "";
          };
          return (
            <section key={s.id} aria-label={`Wahlbogen ${s.name}`} className="flex flex-col gap-4 break-after-page">
              <DruckKopf eyebrow={KIND_LABEL[v.kind]} title={`Wahlbogen ${v.title}`} subtitle={`Abgabe bis ${day(v.closesOn)}`} stamp={`gedruckt am ${stamp.format(new Date())}`} />
              <p className="text-base">
                <strong>{s.name}</strong> · Klasse {s.className}
              </p>
              <table className="w-full border-collapse text-base [&_td]:border-b [&_td]:border-ink/30 [&_td]:py-3 [&_th]:border-b-2 [&_th]:border-ink [&_th]:py-2 [&_th]:text-left">
                <thead>
                  <tr>
                    <th className="w-40">Priorität</th>
                    <th>Angebot</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: v.maxCourses }, (_, p) =>
                    Array.from({ length: need }, (_, i) => (
                      <tr key={`${p}-${i}`}>
                        <td>
                          {multi ? `Kurs ${p + 1}${p + 1 > v.minCourses ? " (freiwillig)" : ""}, ` : ""}
                          {rankLabel(i + 1)}
                        </td>
                        <td>{at(p + 1, i)}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
              <div className="flex flex-col gap-1 text-sm">
                <p className="font-semibold">Angebote</p>
                <ul className="list-disc pl-5">
                  {offers.map((o) => (
                    <li key={o.id}>
                      {o.title}
                      {o.note ? ` – ${o.note}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-10 grid grid-cols-2 gap-10 text-sm">
                <p className="border-t border-ink pt-1">Ort, Datum</p>
                <p className="border-t border-ink pt-1">{self.has(s.id) ? "Unterschrift der Schülerin/des Schülers" : "Unterschrift der Erziehungsberechtigten"}</p>
                {!self.has(s.id) && v.chooser === "schueler" && <p className="col-start-2 mt-8 border-t border-ink pt-1">Unterschrift der Schülerin/des Schülers</p>}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
