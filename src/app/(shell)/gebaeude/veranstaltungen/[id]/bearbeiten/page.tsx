import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { updateEventAction } from "@/modules/gebaeude/actions";
import { EVENT_SCOPE_LABELS, EVENT_SCOPES } from "@/modules/gebaeude/labels";
import { roomOptions } from "@/modules/gebaeude/pruefungen";
import { approvalRequired, getEvent } from "@/modules/gebaeude/veranstaltungen";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { SpecForm, type FieldSpec } from "@/ui/spec-form";
import { eventFields } from "../../felder";

export const metadata: Metadata = { title: "Veranstaltung bearbeiten" };

/**
 * Bearbeiten (VA-05): nur die anmeldende Person, offene oder bestätigte Veranstaltungen vor dem Aufbau – sonst 404. Bei Serien (VA-06)
 * „nur dieser Termin“ oder „dieser und alle folgenden“.
 */
export default async function VeranstaltungBearbeitenPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const { id } = await params;
  const db = await getDb();
  const d = await getEvent(db, perms, id);
  if (!d || !d.can.edit) notFound();
  const e = d.event;
  const [rooms, approval] = await Promise.all([roomOptions(db), approvalRequired(db)]);
  const fields: FieldSpec[] = [
    ...eventFields(rooms, e, ""),
    ...(d.series && d.series.following > 1
      ? [
          {
            name: "scope",
            label: "Änderung gilt für",
            type: "select" as const,
            options: EVENT_SCOPES.map((s) => ({ value: s, label: EVENT_SCOPE_LABELS[s] })),
            defaultValue: "einzeln",
            wide: true,
            hint: `Termin ${d.series.position} von ${d.series.items.length}; „folgende“ verschiebt spätere Termine um denselben Abstand`,
          },
        ]
      : []),
  ];
  const href = `/gebaeude/veranstaltungen/${e.id}`;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Veranstaltung" title="Veranstaltung bearbeiten" />
      <Link href={href} className="text-sm font-medium text-accent-ink hover:underline">
        Zurück zur Veranstaltung
      </Link>
      <p className="max-w-prose text-sm text-muted">
        {e.status === "bestaetigt"
          ? "Ändern sich Zeit oder Räume, ist die Bestätigung aufgehoben: Raumsperren und Schulkalender-Eintrag fallen weg, die Hausmeisterei bestätigt neu."
          : "Die Hausmeisterei sieht die Änderung bei der Bestätigung."}{" "}
        {approval && "Mit geänderter Zeit oder zusätzlichen Räumen geht die Anmeldung erneut zur Freigabe an die Schulleitung. "}
        Titel, Ort ohne Raum, Personenzahl, Bestuhlung, Bedarf und Einzelheiten ändern die Bestätigung nicht.
      </p>
      <Card>
        <SpecForm action={updateEventAction.bind(null, e.id)} label="Veranstaltung bearbeiten" submit="Speichern" fields={fields} />
      </Card>
    </main>
  );
}
