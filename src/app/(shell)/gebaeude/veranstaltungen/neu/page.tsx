import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { addDays, toBerlinDate } from "@/core/time";
import { createEventAction } from "@/modules/gebaeude/actions";
import { EVENT_REPEAT_LABELS, EVENT_REPEATS, EVENT_SERIES_MAX } from "@/modules/gebaeude/labels";
import { roomOptions } from "@/modules/gebaeude/pruefungen";
import { canReport } from "@/modules/gebaeude/service";
import { approvalRequired } from "@/modules/gebaeude/veranstaltungen";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "@/ui/spec-form";
import { eventFields } from "../felder";

export const metadata: Metadata = { title: "Veranstaltung anmelden" };

/**
 * Formular (VA-02): alle mit `gebaeude.report` – Zeitraum mit Auf-/Abbau, Räume oder Ort, Personenzahl, Bedarf. VA-06: optional als
 * Serie (wöchentlich/alle 2 Wochen, bis Datum oder Anzahl, höchstens 26 Termine; Ferien und freie Tage übersprungen).
 */
export default async function NeueVeranstaltungPage() {
  const { perms } = await requireUser();
  if (!canReport(perms)) notFound();
  const db = await getDb();
  const [rooms, approval] = await Promise.all([roomOptions(db), approvalRequired(db)]);
  const day = addDays(toBerlinDate(new Date()), 7);
  const fields: FieldSpec[] = [
    ...eventFields(rooms, null, day),
    {
      name: "repeat",
      label: "Wiederholen",
      type: "select",
      options: EVENT_REPEATS.map((r) => ({ value: r, label: EVENT_REPEAT_LABELS[r] })),
      defaultValue: "keine",
      hint: "Ferien, Feiertage und freie Tage werden übersprungen",
    },
    { name: "until", label: "Wiederholen bis", type: "date", hint: "letzter möglicher Tag – oder die Anzahl" },
    { name: "count", label: "Anzahl der Termine", type: "number", min: 2, max: EVENT_SERIES_MAX, hint: `mit dem ersten, höchstens ${EVENT_SERIES_MAX}` },
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
