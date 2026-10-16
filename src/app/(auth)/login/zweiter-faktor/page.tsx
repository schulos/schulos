import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/core/auth/session";
import { getSchoolSettings } from "@/core/settings";
import { safeNext } from "@schulos/server/safe-next";
import { Logo } from "@schulos/ui/misc";
import { SchoolTheme } from "@/ui/school-theme";
import { SecondFactorForm } from "@schulos/ui/auth-forms";
import { verifySecondFactorAction } from "./actions";
import { PasskeySignIn } from "./passkey-sign-in";

export const metadata: Metadata = { title: "Zweiter Faktor" };
export const dynamic = "force-dynamic";

export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<{ next?: string; schluessel?: string; code?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const [{ next, schluessel, code }, school] = await Promise.all([searchParams, getSchoolSettings()]);
  // SEC-03: Hinweis aus der Anmeldung, welche Wege das Konto hat (nur Anzeige)
  const withKey = schluessel === "1";
  const withCode = code !== "0";
  const target = safeNext(next);
  return (
    <SchoolTheme>
      <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card">
          <div className="mb-6 flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="font-display text-xl font-bold tracking-tight">Zweiter Faktor</h1>
              <p className="text-xs text-muted">{school.name}</p>
            </div>
          </div>
          {withKey && (
            <div className="mb-5 flex flex-col gap-3">
              <p className="text-sm text-muted">Stecke deinen Sicherheitsschlüssel ein bzw. bestätige mit dem Gerät, auf dem dein Passkey liegt.</p>
              <PasskeySignIn next={target} primary />
            </div>
          )}
          {withCode && (
            <>
              {withKey && <p className="mb-3 text-center text-xs text-muted">oder</p>}
              <p className="mb-5 text-sm text-muted">Öffne deine Authenticator-App und gib den aktuellen Code für SchulOS ein.</p>
              <SecondFactorForm action={verifySecondFactorAction} next={target} />
            </>
          )}
          <p className="mt-6 text-center text-xs text-muted">
            <Link href="/login" className="hover:underline">
              Abbrechen
            </Link>
          </p>
        </div>
      </main>
    </SchoolTheme>
  );
}
