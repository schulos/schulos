import type { Metadata } from "next";
import Link from "next/link";
import { RESET_REQUESTED_TEXT } from "@/core/auth/passwort-reset";
import { mailAvailable } from "@/core/mail";
import { getSchoolSettings } from "@/core/settings";
import { Logo } from "@schulos/ui/misc";
import { SchoolTheme } from "@/ui/school-theme";
import { RequestResetForm } from "./forms";

export const metadata: Metadata = { title: "Passwort vergessen" };
export const dynamic = "force-dynamic";

/** P4-70: ohne Anmeldung – Link per Mail nur für Konten mit Zwei-Faktor-Anmeldung und bestätigter Adresse. */
export default async function PasswortVergessenPage() {
  const school = await getSchoolSettings();
  return (
    <SchoolTheme>
      <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card">
          <div className="mb-6 flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight">Passwort vergessen</h1>
              <p className="text-xs text-muted">{school.name}</p>
            </div>
          </div>
          {mailAvailable() ? (
            <>
              <p className="mb-5 text-sm text-muted">
                Für Lehrkräfte, Personal und Eltern mit Zwei-Faktor-Anmeldung und bestätigter E-Mail-Adresse. Alle anderen wenden sich an das
                Sekretariat.
              </p>
              <RequestResetForm doneText={RESET_REQUESTED_TEXT} />
            </>
          ) : (
            <p className="text-sm">Diese Schule verschickt keine E-Mails. Ein neues Passwort bekommst du im Sekretariat.</p>
          )}
          <p className="mt-6 text-center text-xs text-muted">
            <Link href="/login" className="hover:underline">
              Zurück zur Anmeldung
            </Link>
          </p>
        </div>
      </main>
    </SchoolTheme>
  );
}
