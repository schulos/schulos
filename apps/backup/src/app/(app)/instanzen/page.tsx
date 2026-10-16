import type { Metadata } from "next";
import Link from "next/link";
import { certFingerprint } from "@schulos/server/pairing";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { getDb } from "@/db/client";
import { listInstances, openCodes } from "@/pairing/service";
import { tlsCaPem } from "@/settings";
import { requestRunAction, revokeCodeAction } from "./actions";
import { CreateCodeForm, RenameForm, UnpairForm } from "./forms";

export const metadata: Metadata = { title: "Instanzen" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

export default async function InstanzenPage() {
  const db = await getDb();
  const [list, codes] = await Promise.all([listInstances(db), openCodes(db)]);
  const ca = tlsCaPem();
  return (
    <>
      <PageHeader eyebrow="Backupserver" title="Instanzen" />

      <Card aria-label="Koppeln">
        <CardHeader title="Hauptsystem koppeln" />
        <CreateCodeForm />
        <p className="mt-4 text-xs text-muted">
          {ca ? (
            <>
              Das Hauptsystem merkt sich die Zertifizierungsstelle dieses Servers (SHA-256 <span className="font-mono break-all">{certFingerprint(ca)}</span>).
            </>
          ) : (
            "Dieser Server hat ein öffentliches Zertifikat – das Hauptsystem prüft es über die üblichen Zertifizierungsstellen."
          )}
        </p>
      </Card>

      {codes.length > 0 && (
        <Card aria-label="Offene Codes">
          <CardHeader title="Offene Kopplungscodes" />
          <ul className="flex flex-col gap-2 text-sm">
            {codes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {c.replacesInstanceId ? `Ersatz für ${list.find((i) => i.id === c.replacesInstanceId)?.name ?? "eine Instanz"} · ` : ""}
                  erzeugt {fmt.format(c.createdAt)} · gültig bis {fmt.format(c.expiresAt)}
                </span>
                <form action={revokeCodeAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <Button type="submit" size="sm" variant="ghost">
                    Zurückziehen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState title="Noch keine Instanz gekoppelt">Code erzeugen und im Hauptsystem unter Verwaltung → Backup eingeben.</EmptyState>
      ) : (
        list.map((i) => (
          <Card key={i.id} aria-label={i.name}>
            <CardHeader title={<Link href={`/instanzen/${i.id}`} className="hover:underline">{i.name}</Link>} action={{ href: `/instanzen/${i.id}`, label: "Zeitplan, Aufbewahrung, Stände" }} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Gekoppelt</dt>
              <dd>{fmt.format(i.createdAt)}</dd>
              <dt className="text-muted">Hauptsystem</dt>
              <dd>{i.mainUrl ?? "–"}</dd>
              <dt className="text-muted">Repository</dt>
              <dd className="font-mono">{i.restUser}</dd>
              <dt className="text-muted">Zuletzt gemeldet</dt>
              <dd>{i.lastSeenAt ? fmt.format(i.lastSeenAt) : "noch nie"}</dd>
              <dt className="text-muted">Jetzt sichern</dt>
              <dd>{i.runRequestedAt ? `angefordert ${fmt.format(i.runRequestedAt)} – der Agent startet innerhalb einer Minute` : "–"}</dd>
            </dl>
            <form action={requestRunAction} className="mt-3">
              <input type="hidden" name="id" value={i.id} />
              <Button type="submit" size="sm" variant="secondary">
                Jetzt sichern
              </Button>
            </form>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <RenameForm id={i.id} name={i.name} />
              <UnpairForm id={i.id} name={i.name} />
            </div>
          </Card>
        ))
      )}
    </>
  );
}
