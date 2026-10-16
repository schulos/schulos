import type { Metadata } from "next";
import { headers } from "next/headers";
import { getAuth } from "@/core/auth/auth";
import { requireUser } from "@/core/auth/session";
import { idleLabel, listOwnSessions, offlineDeviceCount } from "@/core/auth/sitzungen";
import { getDb } from "@/core/db/client";
import { cachedSecuritySettings } from "@/core/settings";
import { TZ } from "@/core/time";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { EndAllButton, EndSessionButton } from "./buttons";

export const metadata: Metadata = { title: "Angemeldete Geräte" };
export const dynamic = "force-dynamic";

const fmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

/** P4-71: eigene Sitzungen – Gerät, Anmeldung, letzte Aktivität; einzelne Geräte oder überall abmelden. */
export default async function SitzungenPage() {
  const { user } = await requireUser();
  const db = await getDb();
  const session = await (await getAuth()).api.getSession({ headers: await headers() });
  const [rows, offline, security] = await Promise.all([
    listOwnSessions(db, user.id, session?.session.id ?? null),
    offlineDeviceCount(db, user.id),
    cachedSecuritySettings(db),
  ]);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="Angemeldete Geräte" />
      <p className="max-w-2xl text-sm text-muted">
        Hier bist du gerade angemeldet. Kennst du ein Gerät nicht, melde es ab und ändere dein Passwort. Abmelden nach Inaktivität:{" "}
        {idleLabel(security.idleMinutes)}.
      </p>
      <Card aria-label="Sitzungen" className="max-w-3xl">
        <CardHeader title={`Sitzungen (${rows.length})`} />
        <ul className="flex flex-col">
          {rows.map((s) => (
            <li
              key={s.id}
              className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex flex-col leading-tight">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.device}
                  {s.current && <Badge tone="success">dieses Gerät</Badge>}
                  {s.secondFactor && <Badge>mit Code angemeldet</Badge>}
                  {s.offline && <Badge tone="warn">Notenbuch offline</Badge>}
                </span>
                <span className="text-sm text-muted">
                  angemeldet {fmt.format(s.createdAt)} · zuletzt aktiv {fmt.format(s.lastActiveAt)}
                  {s.ip && ` · ${s.ip}`}
                </span>
              </span>
              {!s.current && <EndSessionButton id={s.id} offline={s.offline} />}
            </li>
          ))}
        </ul>
      </Card>
      <div>
        <EndAllButton offline={offline} />
      </div>
    </main>
  );
}
