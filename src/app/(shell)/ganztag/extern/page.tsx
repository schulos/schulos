import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { canManageExternal, defaultExpiry, listExternalLeaders, WARN_DAYS } from "@/modules/ganztag/extern";
import { listOffers } from "@/modules/ganztag/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { CreateExternalForm, ExternalActions } from "./forms";

export const metadata: Metadata = { title: "Ganztag: Externe Leitungen" };

const fmt = (ymd: string) => ymd.split("-").reverse().join(".");

/** GT-13: befristete Konten externer Anbieter als Leitung genau eines Angebots (2FA Pflicht, Ablauf zum Angebotsende). */
export default async function ExternPage() {
  const { perms } = await requireUser();
  if (!canManageExternal(perms)) notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [rows, offers] = await Promise.all([listExternalLeaders(db, perms), listOffers(db, perms)]);
  const expiries = Object.fromEntries(await Promise.all(offers.map(async (o) => [o.id, await defaultExpiry(db, o.id, today)] as const)));

  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ganztag">
          <ArrowLeft aria-hidden /> Ganztag
        </Link>
      </Button>
      <PageHeader eyebrow="Ganztag" title="Externe Leitungen" />
      <p className="text-muted">
        Mitarbeitende externer Anbieter (Verein, Musikschule …) leiten ein Angebot mit einem befristeten Konto: nur die Anwesenheitsliste und der Heimweg ihrer eigenen Gruppe, Zwei-Faktor-Anmeldung ab der ersten
        Anmeldung Pflicht. {WARN_DAYS} Tage vor Ablauf gibt es einen Hinweis, danach ist das Konto gesperrt. Ohne Konto bleibt die Papierliste.
      </p>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Aktuelle Konten</h2>
        {rows.length === 0 ? (
          <EmptyState title="Noch keine externen Leitungen" />
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Externe Leitungen">
            {rows.map((r) => (
              <li key={r.userId} className="flex flex-col gap-2 rounded-xl border border-border p-3">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-sm text-muted">
                    {r.provider} · {r.group.name}
                    {r.username && ` · ${r.username}`}
                  </span>
                  {r.state === "abgelaufen" ? <Badge tone="danger">abgelaufen</Badge> : r.state === "bald" ? <Badge tone="warn">läuft bald ab</Badge> : <Badge tone="success">aktiv</Badge>}
                  {!r.twoFactor && r.state !== "abgelaufen" && <Badge>2FA noch nicht eingerichtet</Badge>}
                </span>
                <span className="text-sm">{r.expiresOn ? `befristet bis ${fmt(r.expiresOn)}` : "ohne Befristung"}</span>
                <ExternalActions userId={r.userId} name={r.name} expiresOn={r.expiresOn ?? today} active={r.state !== "abgelaufen"} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Konto anlegen</h2>
        {offers.length === 0 ? (
          <p className="text-sm text-muted">Zuerst unter „Angebote mit Liste“ die Anwesenheitsliste für das Angebot einschalten.</p>
        ) : (
          <CreateExternalForm offers={offers.map((o) => ({ id: o.id, name: o.name, expiresOn: expiries[o.id]! }))} />
        )}
      </Card>
    </main>
  );
}
