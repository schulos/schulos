import { requireModulePage } from "@/core/modules/guard";
import type { Metadata } from "next";
import { getDb } from "@/core/db/client";
import { monitorData, monitorEnabled, screenByToken } from "@/modules/monitor/service";
import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";
import { Kiosk } from "./kiosk";

export const metadata: Metadata = { title: "Monitor", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Vollbild-Seite für Bildschirme im Foyer/Lehrerzimmer – ohne App-Rahmen und ohne Login. */
export default async function MonitorPage({ params }: { params: Promise<{ token: string }> }) {
  await requireModulePage("monitor");
  const { token } = await params;
  const db = await getDb();
  const screen = (await monitorEnabled(db)) ? await screenByToken(db, token) : null;
  if (!screen) {
    return (
      <main className="grid min-h-dvh place-items-center p-8 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-bold">Monitor nicht verfügbar</h1>
          <p className="text-lg text-muted">Diese Adresse ist ungültig oder wurde gesperrt. Bitte im Sekretariat eine neue Adresse erzeugen lassen.</p>
        </div>
      </main>
    );
  }
  const school = await getSchoolSettings();
  // Logo in der Ecke (Q-11, Symbol bevorzugt) – serverseitig gerendert und an den Kiosk durchgereicht
  const logo = <SchoolLogo logos={school.logos} name={school.name} prefer="symbol" className="h-16 max-w-56" />;
  return <Kiosk token={token} initial={await monitorData(db, screen)} logo={logo} />;
}
