import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { canAuskunft } from "@/modules/anmeldung/auskunft";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { AuskunftSuche } from "./auskunft-suche";

export const metadata: Metadata = { title: "Auskunft Schulanmeldung" };
export const dynamic = "force-dynamic";

/**
 * Auskunft nach Art. 15 zu Anträgen der Schulanmeldung (P4-42). Anträge ohne Konto hängen an keinem Benutzer – die
 * allgemeine Auskunft je Konto findet sie nicht; hier per Vorgangsnummer oder E-Mail-Adresse.
 */
export default async function AnmeldungAuskunftPage() {
  const { perms } = await requireUser();
  if (!canAuskunft(perms)) notFound();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Schulanmeldung" title="Auskunft (Art. 15 DSGVO)" />
      <div className="flex max-w-3xl flex-col gap-2 text-sm text-muted">
        <p>
          Eltern ohne Konto fragen per Vorgangsnummer oder E-Mail-Adresse an. Die Auskunft enthält alle gespeicherten Angaben zum Antrag, den Termin, die
          vorgelegten Unterlagen, die Entscheidung und den Verlauf – Handlungen der Schule ohne Namen von Beschäftigten, ohne die geheimen Links.
        </p>
        <p>
          Vorher die Identität prüfen: Auskunft nur an die im Antrag hinterlegte E-Mail-Adresse bzw. persönlich. Jede Suche und jede Auskunft wird
          protokolliert; die Datei wird nicht auf dem Server abgelegt.
        </p>
        <p>
          Die Adresse des zweiten Elternteils hat die antragstellende Person eingetragen – sie ist nicht bestätigt. Ein Treffer darüber bekommt nur
          eine eingeschränkte Auskunft (eigene Angaben, Vorgangsnummer, Stand), ohne Angaben zur antragstellenden Person und zum Kind.
        </p>
      </div>
      <Card>
        <AuskunftSuche />
      </Card>
    </main>
  );
}
