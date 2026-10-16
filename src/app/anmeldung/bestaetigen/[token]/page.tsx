import type { Metadata } from "next";
import { getDb } from "@/core/db/client";
import { publicIp } from "@/core/public-action";
import { confirmPreview } from "@/modules/anmeldung/public";
import { Card, CardHeader } from "@schulos/ui/card";
import { ConfirmButton } from "./confirm";

export const metadata: Metadata = { title: "Anmeldung bestätigen" };
export const dynamic = "force-dynamic";

/**
 * Bestätigungslink (P4-34, Double-Opt-In). Bestätigt wird erst per Knopf (POST) – Link-Vorschauen von Mailprogrammen lösen
 * so nichts aus. Die Seite zeigt nur den Namen des Verfahrens, keine Personendaten.
 */
export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = decodeURIComponent(token);
  const r = await confirmPreview(await getDb(), t, { ip: await publicIp(), now: new Date() });
  return (
    <main className="flex flex-col gap-6">
      <h1 className="font-display text-3xl font-bold tracking-tight">Anmeldung bestätigen</h1>
      <Card>
        {r.state === "ok" ? (
          <div className="flex flex-col gap-3">
            <CardHeader title={r.value.verfahren} />
            <p>Bitte bestätigen Sie Ihre Anmeldung. Danach bekommen Sie eine E-Mail mit Vorgangsnummer, Termin und der Liste der Unterlagen.</p>
            <ConfirmButton token={t} />
          </div>
        ) : r.state === "limited" ? (
          <p role="alert">Zu viele Versuche in kurzer Zeit. Bitte später noch einmal versuchen.</p>
        ) : (
          <p role="alert">
            Der Link ist ungültig oder abgelaufen. Bestätigungslinks gelten 48 Stunden und nur einmal – danach bitte noch einmal anmelden.
          </p>
        )}
      </Card>
    </main>
  );
}
