import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RegenerateCodesForm, SetupPanel } from "@schulos/ui/auth-forms";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { getCurrentUser } from "@/auth/session";
import { logoutAction } from "../login/actions";
import { AuthCard } from "../auth-card";
import { confirmSetupAction, regenerateCodesAction, startSetupAction } from "./actions";

export const metadata: Metadata = { title: "Zwei-Faktor-Anmeldung" };
export const dynamic = "force-dynamic";

// Außerhalb der Shell: die Shell leitet Konten ohne zweiten Faktor hierher um (Pflicht für alle Konten).
export default async function ZweiFaktorPage({ searchParams }: { searchParams: Promise<{ eingerichtet?: string }> }) {
  const sp = await searchParams;
  const current = await getCurrentUser();
  if (!current) redirect("/login?next=/zwei-faktor");

  return (
    <AuthCard title="Zwei-Faktor-Anmeldung" subtitle={`${current.name} · SchulOS Backup`} wide>
      <div className="flex flex-col gap-6">
        <div>
          <Badge tone={current.twoFactorEnabled ? "success" : "warn"}>{current.twoFactorEnabled ? "eingeschaltet" : "noch nicht eingerichtet"}</Badge>
        </div>
        {sp.eingerichtet && current.twoFactorEnabled && (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
            Zwei-Faktor-Anmeldung ist eingerichtet. Ab der nächsten Anmeldung fragt der Backupserver nach dem Code.
          </p>
        )}
        {current.twoFactorEnabled ? (
          <Card aria-label="Wiederherstellungscodes">
            <CardHeader title="Wiederherstellungscodes" />
            <RegenerateCodesForm action={regenerateCodesAction} />
          </Card>
        ) : (
          <>
            <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
              Auf dem Backupserver ist die Zwei-Faktor-Anmeldung für <strong>jedes Konto Pflicht</strong> – hier liegen die Schlüssel zu
              allen Sicherungen. Richte sie jetzt ein, um weiterzuarbeiten.
            </p>
            <Card aria-label="Einrichten">
              <CardHeader title="Einrichten" />
              <SetupPanel start={startSetupAction} confirm={confirmSetupAction} />
            </Card>
          </>
        )}
        <div className="text-sm">
          {current.twoFactorEnabled ? (
            <Link href="/" className="text-muted underline">
              Zur Übersicht
            </Link>
          ) : (
            <form action={logoutAction} className="inline">
              <button type="submit" className="text-muted underline">
                Abmelden
              </button>
            </form>
          )}
        </div>
      </div>
    </AuthCard>
  );
}
