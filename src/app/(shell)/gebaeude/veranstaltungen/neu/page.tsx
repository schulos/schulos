import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import { createEventAction } from "@/modules/gebaeude/actions";
import { EVENT_NEED_KEYS, EVENT_NEEDS, EVENT_SEATING, EVENT_SEATING_LABELS, EVENT_TEXT_MAX } from "@/modules/gebaeude/labels";
import { roomOptions } from "@/modules/gebaeude/pruefungen";
import { canReport } from "@/modules/gebaeude/service";
import { approvalRequired } from "@/modules/gebaeude/veranstaltungen";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "@/ui/spec-form";

export const metadata: Metadata = { title: "Veranstaltung anmelden" };

/** Formular (VA-02): alle mit `gebaeude.report` – Zeitraum mit Auf-/Abbau, Räume oder Ort, Personenzahl, Bedarf. */
export default async function NeueVeranstaltungPage() {
  const { perms } = await requireUser();
  if (!canReport(perms)) notFound();
  const db = await getDb();
  const [rooms, approval] = await Promise.all([roomOptions(db), approvalRequired(db)]);
  const day = addDays(toBerlinDate(new Date()), 7);
  const fields: FieldSpec[] = [
    { name: "title", label: "Was findet statt?", type: "text", required: true, maxLength: 120, wide: true, placeholder: "z. B. Elternabend Jahrgang 5" },
    { name: "start", label: "Beginn", type: "datetime-local", required: true, defaultValue: `${day}T18:00` },
    { name: "end", label: "Ende", type: "datetime-local", required: true, defaultValue: `${day}T20:00` },
    { name: "setup", label: "Aufbau ab", type: "datetime-local", hint: "leer = ab Beginn" },
    { name: "teardown", label: "Abbau bis", type: "datetime-local", hint: "leer = bis Ende" },
    { name: "roomIds", label: "Räume", type: "multiselect", options: rooms, wide: true, hint: "mehrere mit Strg bzw. ⌘" },
    { name: "location", label: "Ort ohne Raum", type: "text", maxLength: 120, placeholder: "z. B. Schulhof, Sportplatz" },
    { name: "persons", label: "Erwartete Personen", type: "number", required: true, min: 1, max: 5000 },
    { name: "seating", label: "Bestuhlung", type: "select", options: EVENT_SEATING.map((s) => ({ value: s, label: EVENT_SEATING_LABELS[s] })), defaultValue: "keine" },
    ...EVENT_NEED_KEYS.map((k): FieldSpec => ({ name: k, label: EVENT_NEEDS[k], type: "checkbox", wide: true })),
    {
      name: "details",
      label: "Einzelheiten zum Bedarf",
      type: "textarea",
      maxLength: EVENT_TEXT_MAX,
      wide: true,
      hint: "z. B. Bühne, zwei Mikrofone, Tür zum Hof offen – bitte ohne Namen von Schüler:innen",
    },
  ];
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Gebäude & Technik" title="Veranstaltung anmelden" />
      <p className="max-w-prose text-sm text-muted">
        {approval ? "Die Anmeldung geht zuerst zur Freigabe an die Schulleitung, danach an die Hausmeisterei." : "Die Anmeldung geht an die Hausmeisterei."} Sie bekommen eine
        Benachrichtigung, sobald sie bestätigt ist oder es eine Rückfrage gibt. Räume mit Unterricht in dieser Zeit sperrt die Hausmeisterei bei der Bestätigung.{" "}
        <Link href="/gebaeude/veranstaltungen" className="font-medium text-accent-ink hover:underline">
          Meine Veranstaltungen
        </Link>
      </p>
      <Card>
        <SpecForm action={createEventAction} label="Veranstaltung anmelden" submit="Anmelden" fields={fields} />
      </Card>
    </main>
  );
}
