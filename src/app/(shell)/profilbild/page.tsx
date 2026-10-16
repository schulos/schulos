import type { Metadata } from "next";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { photoSubjects } from "@/core/privacy/profilbild";
import { toBerlinDate } from "@/core/time";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { PhotoCardBody } from "./photo-card";

export const metadata: Metadata = { title: "Profilbild" };

export default async function ProfilbildPage() {
  const { perms } = await requireUser();
  const people = await photoSubjects(await getDb(), perms);
  const today = toBerlinDate(new Date());
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="Profilbild" />
      <p className="max-w-3xl text-sm text-muted">
        Ein Foto erscheint nur mit Einwilligung. Wer sie widerruft, löscht das Foto sofort; danach zeigt SchulOS wieder die
        Initialen. Metadaten des Fotos (z. B. Aufnahmeort) werden beim Hochladen entfernt.
      </p>
      {people.length === 0 && <EmptyState title="Keine Personen" />}
      <div className="grid gap-6 lg:grid-cols-2">
        {people.map((p) => (
          <Card key={p.id} aria-label={p.name}>
            <CardHeader title={p.own ? "Mein Profilbild" : p.name} />
            <PhotoCardBody {...p} today={today} />
          </Card>
        ))}
      </div>
    </main>
  );
}
