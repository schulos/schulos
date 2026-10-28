import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { createInfoFieldAction, deleteInfoFieldAction, updateInfoFieldAction } from "@/modules/verwaltung/raum-info-actions";
import { INFO_FIELDS_MAX, listInfoFields } from "@/modules/verwaltung/raumsteckbrief";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { DeleteFieldButton, InfoFieldForm } from "./field-forms";

export const metadata: Metadata = { title: "Infofelder der Räume" };

/** RS-03: schulweite Infofelder des Raumsteckbriefs mit Sichtbarkeit – Stammdaten (`verwaltung.school`). */
export default async function InfofelderPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.school")) notFound();
  const fields = await listInfoFields(await getDb());
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Stammdaten · Räume" title="Infofelder im Raumsteckbrief" />
      <p className="text-sm text-muted">
        Infofelder gelten für alle Räume. „Nur Personal“ sehen Beschäftigte, „alle“ auch Schüler:innen und Eltern. Technik, Netz,
        Sicherheit und Durchwahl bleiben am besten beim Personal. Keine Personendaten eintragen. Werte pflegt, wer Räume bearbeiten
        darf – im Steckbrief eines Raums unter „Infofelder bearbeiten“.{" "}
        <Link href="/verwaltung/stammdaten?bereich=raeume" className="font-medium text-accent-ink hover:underline">
          Zur Raumliste
        </Link>
      </p>
      <Card>
        <CardHeader title="Vorhandene Infofelder" />
        {fields.length === 0 && <p className="text-sm text-muted">Noch keine Infofelder.</p>}
        <ul className="flex flex-col divide-y divide-border">
          {fields.map((f) => (
            <li key={f.id} className="flex flex-col gap-2 py-3 first:pt-0">
              <InfoFieldForm
                name={`Infofeld ${f.label}`}
                action={updateInfoFieldAction.bind(null, f.id)}
                initial={{ label: f.label, visibility: f.visibility, sortOrder: f.sortOrder }}
                submitLabel="Speichern"
              />
              <div className="self-end">
                <DeleteFieldButton action={deleteInfoFieldAction.bind(null, f.id)} label={f.label} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {fields.length < INFO_FIELDS_MAX && (
        <Card>
          <CardHeader title="Neues Infofeld" />
          <InfoFieldForm name="Neues Infofeld" action={createInfoFieldAction} submitLabel="Anlegen" />
        </Card>
      )}
    </main>
  );
}
