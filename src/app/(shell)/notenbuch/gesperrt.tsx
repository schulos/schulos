import { notenbuchReloginAction } from "@/modules/notenbuch/actions";
import { IDLE_MINUTES } from "@/modules/notenbuch/sitzung";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";

/**
 * Sperrseite (P5-12): keine Daten, nur der Weg zur neuen Anmeldung – nach Inaktivität (`locked`) oder, GATE-5a (G5A-S04), wenn
 * diese Sitzung nicht mit zweitem Faktor angemeldet ist (z. B. direkt nach dem Einrichten der Zwei-Faktor-Anmeldung).
 */
export function NotenbuchLocked({ reason = "locked" }: { reason?: "locked" | "zweiter-faktor" }) {
  const secondFactor = reason === "zweiter-faktor";
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Unterricht" title={secondFactor ? "Notenbuch: Anmeldung mit Code nötig" : "Notenbuch gesperrt"} />
      <Card aria-labelledby="gesperrt" className="max-w-2xl">
        <h2 id="gesperrt" className="text-base font-semibold">
          {secondFactor ? "Diese Sitzung ist nicht mit zweitem Faktor angemeldet" : `Nach ${IDLE_MINUTES} Minuten ohne Eingabe ist das Notenbuch gesperrt`}
        </h2>
        <p className="text-sm text-muted">
          {secondFactor
            ? "Das Notenbuch öffnet sich nur in einer Sitzung, die mit Passwort und Code aus der Authenticator-App angemeldet wurde – auch direkt nach dem Einrichten. Melde dich dazu einmal neu an; die übrigen Bereiche von SchulOS bleiben bis dahin nutzbar."
            : "So sieht an einem offen gelassenen Gerät niemand Noten. Zum Weiterarbeiten meldest du dich neu an (mit zweitem Faktor) – die übrigen Bereiche von SchulOS bleiben bis dahin nutzbar."}
        </p>
        <form action={notenbuchReloginAction}>
          <Button type="submit" variant="primary">
            Neu anmelden
          </Button>
        </form>
      </Card>
    </main>
  );
}
