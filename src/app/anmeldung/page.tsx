import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { VERFAHREN_KIND_LABELS } from "@/modules/anmeldung/labels";
import { openVerfahren } from "@/modules/anmeldung/service";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";

export const metadata: Metadata = { title: "Schulanmeldung" };
export const dynamic = "force-dynamic";

const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: TZ });

/** Öffentliche Übersicht (P4-34): veröffentlichte Verfahren, deren Anmeldezeitraum gerade läuft. */
export default async function AnmeldungStartPage() {
  const list = await openVerfahren(await getDb());
  return (
    <main className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">Schulanmeldung</h1>
        <p className="mt-2 text-muted">
          Hier melden Sie Ihr Kind online vor und wählen einen Termin für das Anmeldegespräch. Verbindlich wird die Anmeldung erst im persönlichen
          Gespräch, zu dem Sie die Unterlagen im Original mitbringen.
        </p>
      </div>
      {list.length === 0 ? (
        <Card>
          <p>Zurzeit ist keine Anmeldung geöffnet.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4" aria-label="Offene Anmeldungen">
          {list.map((v) => (
            <li key={v.id}>
              <Card aria-label={v.name}>
                <CardHeader title={v.name} />
                <p className="text-sm text-muted">{VERFAHREN_KIND_LABELS[v.kind]}</p>
                <p className="mt-1 text-sm">Anmeldung bis {dateTime.format(v.closesAt)} Uhr</p>
                <Button asChild variant="primary" className="mt-3 w-fit">
                  <Link href={`/anmeldung/${v.id}`}>Zur Anmeldung</Link>
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
