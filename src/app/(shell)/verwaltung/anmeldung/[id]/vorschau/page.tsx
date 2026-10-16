import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { readSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import { anmeldungKatalog } from "@/modules/anmeldung/katalog";
import { OPTIONAL_FIELDS, OPTIONAL_FIELD_LABELS } from "@/modules/anmeldung/labels";
import { freeSlots, getVerfahren } from "@/modules/anmeldung/service";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { dateTime, dayFmt, timeFmt, VerfahrenNav } from "../../shared";

export const metadata: Metadata = { title: "Vorschau für Eltern" };
export const dynamic = "force-dynamic";

/**
 * Vorschau als Elternteil (P4-33): Hinweistext, Unterlagen, abgefragte Angaben und freie Termine – so, wie das öffentliche
 * Formular (P4-34) sie zeigt. Nur lesen, nichts wird gespeichert.
 */
export default async function VorschauPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const v = await getVerfahren(db, perms, decodeURIComponent(id)).catch(() => null);
  if (!v) notFound();
  const [slots, school] = await Promise.all([freeSlots(db, v.id), readSchoolSettings(db)]);
  const katalog = anmeldungKatalog(school.profile.state);
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) byDay.set(toBerlinDate(s.startsAt), [...(byDay.get(toBerlinDate(s.startsAt)) ?? []), s]);
  const asked = [
    "Name und Geburtsdatum des Kindes",
    "Grundschule",
    "Name, E-Mail-Adresse und Telefon eines Elternteils",
    "Anschrift",
    ...OPTIONAL_FIELDS.filter((f) => v.fieldSet[f]).map((f) => OPTIONAL_FIELD_LABELS[f]),
    "Gesprächstermin",
    "Kenntnisnahme der Datenschutzhinweise",
  ];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Vorschau für Eltern" title={v.name} />
      <VerfahrenNav id={v.id} current="vorschau" />
      <p role="note" className="max-w-3xl rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
        So sehen Eltern das Verfahren{v.status === "offen" ? "" : " nach dem Veröffentlichen"} – Anmeldung vom {dateTime.format(v.opensAt)} bis{" "}
        {dateTime.format(v.closesAt)}.
      </p>
      <article aria-label="Vorschau" className="flex max-w-3xl flex-col gap-6" data-theme="light">
        <Card>
          <CardHeader title={school.name} />
          {v.intro ? <p className="text-sm whitespace-pre-line">{v.intro}</p> : <p className="text-sm text-muted italic">Kein Hinweistext.</p>}
        </Card>
        <Card aria-label="Unterlagen">
          <CardHeader title="Zum Gespräch mitbringen" />
          <ul className="list-disc pl-5 text-sm">
            {katalog.checklist.map((c) => (
              <li key={c.key}>{c.label}</li>
            ))}
          </ul>
        </Card>
        <Card aria-label="Abgefragte Angaben">
          <CardHeader title="Abgefragte Angaben" />
          <ul className="list-disc pl-5 text-sm">
            {asked.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Nicht abgefragt: Religion, Förderbedarf, Gesundheitsdaten, Noten – das klärt das Gespräch.</p>
        </Card>
        <Card aria-label="Freie Termine">
          <CardHeader title="Freie Gesprächstermine" />
          {slots.length === 0 ? (
            <p className="text-sm text-muted">Keine freien Termine.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {[...byDay].map(([d, list]) => (
                <div key={d}>
                  <p className="text-sm font-medium">{dayFmt.format(list[0]!.startsAt)}</p>
                  <p className="text-sm tabular-nums">{list.map((s) => timeFmt.format(s.startsAt)).join(" · ")}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </article>
    </main>
  );
}
