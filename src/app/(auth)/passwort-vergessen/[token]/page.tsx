import type { Metadata } from "next";
import Link from "next/link";
import { pendingPasswordReset } from "@/core/auth/passwort-reset";
import { getDb } from "@/core/db/client";
import { getSchoolSettings } from "@/core/settings";
import { Logo } from "@schulos/ui/misc";
import { SchoolTheme } from "@/ui/school-theme";
import { CompleteResetForm } from "../forms";

export const metadata: Metadata = { title: "Neues Passwort", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/** P4-70: neues Passwort über den Link aus der Mail (1 h, einmal). */
export default async function NeuesPasswortPage({ params }: { params: Promise<{ token: string }> }) {
  const [{ token }, school] = await Promise.all([params, getSchoolSettings()]);
  const pending = await pendingPasswordReset(await getDb(), token);
  return (
    <SchoolTheme>
      <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card">
          <div className="mb-6 flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight">Neues Passwort</h1>
              <p className="text-xs text-muted">{school.name}</p>
            </div>
          </div>
          {pending ? (
            <>
              <p className="mb-5 text-sm text-muted">
                Für {pending.name}. Danach meldest du dich mit dem neuen Passwort und dem Code aus der Authenticator-App an.
              </p>
              <CompleteResetForm token={token} />
            </>
          ) : (
            <p role="alert" className="text-sm">
              Der Link ist ungültig oder abgelaufen.{" "}
              <Link href="/passwort-vergessen" className="font-medium text-accent-ink hover:underline">
                Neuen Link anfordern
              </Link>
            </p>
          )}
        </div>
      </main>
    </SchoolTheme>
  );
}
