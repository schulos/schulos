import type { Metadata } from "next";
import { requireUser } from "@/core/auth/session";
import { Card, CardHeader } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { InstallButton } from "./install-button";

export const metadata: Metadata = { title: "Als App installieren" };

/** P4-73: Installationshinweis – SchulOS als App auf Handy, Tablet und Computer (ohne Push, ohne gespeicherte Inhalte). */
export default async function AppPage() {
  await requireUser();
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Mein Konto" title="Als App installieren" />
      <p className="max-w-2xl text-sm text-muted">
        SchulOS lässt sich wie eine App auf den Startbildschirm legen und öffnet sich dann ohne Adressleiste. Es ist dieselbe Plattform wie im Browser – mit
        derselben Anmeldung.
      </p>
      <Card aria-labelledby="installieren" className="max-w-3xl">
        <CardHeader title={<span id="installieren">Installieren</span>} />
        <InstallButton />
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>
            <strong>Android (Chrome), Windows und macOS (Chrome, Edge):</strong> im Browsermenü „App installieren“ bzw. „Zum Startbildschirm hinzufügen“ wählen
            – oder oben auf „Jetzt installieren“, wenn der Knopf erscheint.
          </li>
          <li>
            <strong>iPhone und iPad (Safari):</strong> auf „Teilen“ tippen, dann „Zum Home-Bildschirm“.
          </li>
          <li>
            <strong>Firefox:</strong> auf Android im Menü „Installieren“; am Computer bietet Firefox keine Installation an – einfach als Lesezeichen nutzen.
          </li>
        </ul>
      </Card>
      <Card aria-labelledby="was-gespeichert" className="max-w-3xl">
        <CardHeader title={<span id="was-gespeichert">Was auf dem Gerät gespeichert wird</span>} />
        <p className="text-sm">
          Nur Programmdateien (Schriften, Skripte, Symbole), damit SchulOS schneller startet. <strong>Keine Inhalte:</strong> Nachrichten, Pläne, Noten und
          Dateien kommen immer frisch vom Schulserver. Ohne Verbindung zeigt die App nur den Hinweis „Keine Verbindung“. Beim Abmelden werden die gespeicherten
          Programmdateien gelöscht. Benachrichtigungen aufs Handy (Push) gibt es nicht – neue Nachrichten zeigt der Gong in SchulOS.
        </p>
      </Card>
    </main>
  );
}
