import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ } from "@/core/time";
import { canApplyWithAccount, myAntraege } from "@/modules/anmeldung/konto";
import { ANTRAG_STATUS_LABELS, VERFAHREN_KIND_LABELS } from "@/modules/anmeldung/labels";
import { openVerfahren } from "@/modules/anmeldung/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Schulanmeldung" };
export const dynamic = "force-dynamic";

const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: TZ });

/** Eltern mit Konto (P4-34b): weiteres Kind anmelden, eigene Anmeldungen ansehen. */
export default async function SchulanmeldungPage() {
  const { perms } = await requireUser();
  if (!canApplyWithAccount(perms)) notFound();
  const db = await getDb();
  const [mine, open] = await Promise.all([myAntraege(db, perms), openVerfahren(db)]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Für Eltern" title="Schulanmeldung" />
      <p className="max-w-3xl text-sm text-muted">
        Hier melden Sie ein weiteres Kind an unserer Schule an. Ihre Angaben aus dem Konto sind vorbelegt; eine Bestätigung per E-Mail ist nicht nötig.
        Verbindlich wird die Anmeldung erst im persönlichen Gespräch.
      </p>
      <Card aria-label="Meine Anmeldungen">
        <CardHeader title="Meine Anmeldungen" />
        {mine.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Anmeldung.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {mine.map((a) => (
              <li key={a.id}>
                <Link href={`/schulanmeldung/antrag/${a.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {a.childFirstName} · {a.verfahren}
                    </span>
                    <span className="text-xs text-muted tabular-nums">{a.number}</span>
                  </span>
                  <Badge tone="soft">{ANTRAG_STATUS_LABELS[a.status]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <section aria-label="Offene Anmeldungen" className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-bold">Offene Anmeldungen</h2>
        {open.length === 0 ? (
          <p className="text-sm text-muted">Zurzeit ist keine Anmeldung geöffnet.</p>
        ) : (
          open.map((v) => (
            <Card key={v.id} aria-label={v.name}>
              <CardHeader title={v.name} />
              <p className="text-sm text-muted">{VERFAHREN_KIND_LABELS[v.kind]}</p>
              <p className="mt-1 text-sm">Anmeldung bis {dateTime.format(v.closesAt)} Uhr</p>
              <Button asChild variant="primary" className="mt-3 w-fit">
                <Link href={`/schulanmeldung/${v.id}`}>Kind anmelden</Link>
              </Button>
            </Card>
          ))
        )}
      </section>
    </main>
  );
}
