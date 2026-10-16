import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/app/(auth)/login/actions";
import { PASSWORD_MIN } from "@schulos/server/passwort";
import { getCurrentUser } from "@/core/auth/session";
import { getSchoolSettings } from "@/core/settings";
import { Card } from "@schulos/ui/card";
import { Logo } from "@schulos/ui/misc";
import { SchoolTheme } from "@/ui/school-theme";
import { PasswordChangeForm } from "@schulos/ui/auth-forms";
import { changePasswordAction } from "./actions";

export const metadata: Metadata = { title: "Passwort ändern" };
export const dynamic = "force-dynamic";

// Außerhalb der Shell: die Shell leitet Konten mit Startpasswort hierher um.
export default async function PasswortPage({ searchParams }: { searchParams: Promise<{ geaendert?: string }> }) {
  const sp = await searchParams;
  const current = await getCurrentUser();
  if (!current) redirect("/login?next=/passwort");
  const pending = Boolean(current.perms.passwordChangePending);
  const school = await getSchoolSettings();

  return (
    <SchoolTheme>
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 bg-ground px-4 py-10">
        <div className="flex items-center gap-3">
          <Logo />
          <div className="min-w-0">
            <h1 className="font-display text-xl font-bold tracking-tight">Passwort ändern</h1>
            <p className="text-xs text-muted">
              {current.user.name} · {school.name}
            </p>
          </div>
        </div>
        {sp.geaendert && !pending ? (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
            Das Passwort ist geändert. Andere Geräte wurden abgemeldet.
          </p>
        ) : (
          <>
            {pending && (
              <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
                Du meldest dich mit einem <strong>Startpasswort</strong> an. Bitte wähle jetzt ein eigenes Passwort, um weiterzuarbeiten.
              </p>
            )}
            <Card>
              <PasswordChangeForm action={changePasswordAction} min={PASSWORD_MIN} />
            </Card>
          </>
        )}
        <div className="text-sm">
          {pending ? (
            <form action={logoutAction} className="inline">
              <button type="submit" className="text-muted underline">
                Abmelden
              </button>
            </form>
          ) : (
            <Link href="/" className="text-muted underline">
              {sp.geaendert ? "Weiter zu SchulOS" : "Zurück zu SchulOS"}
            </Link>
          )}
        </div>
      </main>
    </SchoolTheme>
  );
}
