import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PASSWORD_MIN } from "@schulos/server/passwort";
import { PasswordChangeForm } from "@schulos/ui/auth-forms";
import { getCurrentUser } from "@/auth/session";
import { logoutAction } from "../login/actions";
import { AuthCard } from "../auth-card";
import { changePasswordAction } from "./actions";

export const metadata: Metadata = { title: "Passwort ändern" };
export const dynamic = "force-dynamic";

// Außerhalb der Shell: requireUser leitet Konten mit Startpasswort hierher um.
export default async function PasswortPage({ searchParams }: { searchParams: Promise<{ geaendert?: string }> }) {
  const sp = await searchParams;
  const current = await getCurrentUser();
  if (!current) redirect("/login?next=/passwort");
  return (
    <AuthCard title="Passwort ändern" subtitle={`${current.name} · SchulOS Backup`}>
      <div className="flex flex-col gap-5">
        {sp.geaendert && !current.mustChangePassword ? (
          <>
            <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
              Das Passwort ist geändert. Andere Sitzungen wurden abgemeldet.
            </p>
            <Link href="/" className="text-sm text-muted underline">
              Weiter
            </Link>
          </>
        ) : (
          <>
            {current.mustChangePassword && (
              <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
                Du meldest dich mit einem Startpasswort an. Bitte jetzt ein eigenes Passwort festlegen.
              </p>
            )}
            <PasswordChangeForm action={changePasswordAction} min={PASSWORD_MIN} />
            <div className="text-sm">
              {current.mustChangePassword ? (
                <form action={logoutAction} className="inline">
                  <button type="submit" className="text-muted underline">
                    Abmelden
                  </button>
                </form>
              ) : (
                <Link href="/" className="text-muted underline">
                  Abbrechen
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </AuthCard>
  );
}
