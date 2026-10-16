// REPO-03: Vorschau-/Haftungshinweis in der Web-Oberfläche – Band für Admins (Recht `verwaltung.system`), solange niemand die
// aktuelle Fassung bestätigt hat, und die dauerhafte Karte unter Verwaltung → System. Demo-Instanzen zeigen kein Band (fiktive
// Daten, eigenes DEMO-Band), die Karte aber schon.
import Link from "next/link";
import { DISCLAIMER_LINES, DISCLAIMER_TITLE } from "@schulos/server/disclaimer";
import { getDb } from "@/core/db/client";
import { readDisclaimerAck } from "@/core/disclaimer";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { TZ } from "@/core/time";
import { ackDisclaimerAction } from "@/modules/verwaltung/system-actions";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";

const fmt = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

export async function DisclaimerBand({
  perms,
  demo,
}: {
  perms: PermissionSet;
  demo: boolean;
}) {
  if (demo || !hasPermission(perms, "verwaltung.system")) return null;
  if (await readDisclaimerAck(await getDb())) return null;
  return (
    <div
      role="note"
      aria-label="Vorschau-Hinweis"
      className="border-b border-warn-border bg-warn-soft px-4 py-1.5 text-center text-xs font-semibold text-warn"
    >
      Vorschau-Version – ohne Gewähr und ohne Support.{" "}
      <Link
        href="/verwaltung/system#vorschau"
        className="underline underline-offset-2"
      >
        Hinweis lesen und bestätigen
      </Link>
    </div>
  );
}

export async function DisclaimerCard() {
  const ack = await readDisclaimerAck(await getDb());
  return (
    <Card aria-label="Vorschau-Hinweis" id="vorschau">
      <CardHeader title="Vorschau-Version" />
      <div className="flex flex-col gap-3 text-sm">
        <p className="font-semibold">{DISCLAIMER_TITLE}</p>
        <ul className="list-disc pl-5">
          {DISCLAIMER_LINES.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {ack ? (
          <p className="flex flex-wrap items-center gap-2 text-muted">
            <Badge tone="neutral">bestätigt</Badge>
            am {fmt.format(new Date(ack.at))} (wer, steht im Protokoll)
          </p>
        ) : (
          <form action={ackDisclaimerAction}>
            <Button type="submit">Gelesen und verstanden</Button>
          </form>
        )}
      </div>
    </Card>
  );
}
