import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { listScreens, monitorEnabled, seenAgo } from "@/modules/monitor/service";
import { monitorBoards } from "@/modules/pinnwaende/service";
import { PageHeader } from "@schulos/ui/misc";
import { MonitorsClient } from "./monitors-client";

export const metadata: Metadata = { title: "Monitore" };

export default async function MonitorePage() {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!hasPermission(perms, "monitor.manage") || !(await monitorEnabled(db))) notFound();
  const screens = await listScreens(db);
  const now = new Date();
  return (
    <main className="flex max-w-4xl flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Monitore" />
      <p className="text-sm text-muted">
        Bildschirme im Foyer oder Lehrerzimmer zeigen den Vertretungsplan von heute und dem nächsten Schultag, die Termine des Tages und ein Laufband mit News (in der News „Im Laufband der
        Monitore zeigen“ ankreuzen). Kein Login am Gerät: jeder Monitor hat eine geheime Adresse. Namen von Schüler:innen erscheinen nie.
      </p>
      <MonitorsClient
        screens={screens.map((s) => ({
          id: s.id,
          name: s.name,
          location: s.location,
          profile: s.profile,
          active: s.tokenHash !== null,
          lastSeen: s.lastSeenAt ? seenAgo(s.lastSeenAt, now) : null,
          boardId: s.boardId,
        }))}
        boards={await monitorBoards(db)}
      />
    </main>
  );
}
