import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logoutAction } from "@/app/(auth)/login/actions";
import { headers } from "next/headers";
import { hasCodeList } from "@/core/auth/codeliste";
import { SETUP_BLOCKED_TEXT, setupAllowedFor } from "@/core/auth/pflicht";
import { getCurrentUser } from "@/core/auth/session";
import { twoFactorStatus } from "@/core/auth/zwei-faktor";
import { getDb } from "@/core/db/client";
import { getSchoolSettings } from "@/core/settings";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { Logo } from "@schulos/ui/misc";
import { SchoolTheme } from "@/ui/school-theme";
import { DisableForm, RegenerateCodesForm, SetupPanel } from "@schulos/ui/auth-forms";
import { listPasskeys } from "@/core/auth/passkeys";
import { CodeListForm } from "./code-form";
import { PasskeyPanel } from "./passkey-panel";
import { confirmSetupAction, confirmSetupForNotenbuchAction, disableAction, regenerateCodesAction, startSetupAction } from "./actions";

export const metadata: Metadata = { title: "Zwei-Faktor-Anmeldung" };
export const dynamic = "force-dynamic";

const dueText = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

// Außerhalb der Shell: die Shell leitet Pflicht-Konten ohne 2FA hierher um.
export default async function ZweiFaktorPage({ searchParams }: { searchParams: Promise<{ eingerichtet?: string; ausgeschaltet?: string; grund?: string; schluessel?: string; entfernt?: string }> }) {
  const sp = await searchParams;
  const current = await getCurrentUser();
  if (!current) redirect("/login?next=/zwei-faktor");
  const db = await getDb();
  const [status, school, setupOk] = await Promise.all([twoFactorStatus(db, current.perms), getSchoolSettings(), headers().then((h) => setupAllowedFor(db, h, current.user.id))]);
  const pending = Boolean(current.perms.twoFactorPending);
  const reason = current.perms.twoFactorReason;
  const codeList = reason === "aussen-code" && (await hasCodeList(db, current.user.id));
  const keys = (await listPasskeys(db, current.user.id)).map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null }));
  // SEC-03: wer schon einen zweiten Faktor hat, darf weitere ergänzen; die Ersteinrichtung folgt SEC-01 (Schulnetz/Freigabe)
  const mayAdd = setupOk || status.enabled;

  return (
    <SchoolTheme>
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 bg-ground px-4 py-10">
        <div className="flex items-center gap-3">
          <Logo />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl font-bold tracking-tight">Zwei-Faktor-Anmeldung</h1>
            <p className="text-xs text-muted">
              {current.user.name} · {school.name}
            </p>
          </div>
          <Badge tone={status.enabled ? "success" : status.enforced ? "warn" : undefined}>{status.enabled ? "eingeschaltet" : "aus"}</Badge>
        </div>

        {sp.eingerichtet && status.enabled && (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
            Zwei-Faktor-Anmeldung ist eingerichtet. Ab der nächsten Anmeldung fragt SchulOS nach dem Code.
          </p>
        )}
        {sp.schluessel && status.passkeys > 0 && (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-success">
            Sicherheitsschlüssel ist eingerichtet. Bei der Anmeldung fragt SchulOS nach dem Passwort nach einem Schlüssel.
          </p>
        )}
        {sp.entfernt && (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium">
            Schlüssel entfernt.{!status.enabled && " Die Zwei-Faktor-Anmeldung ist damit aus."}
          </p>
        )}
        {sp.ausgeschaltet && !status.enabled && (
          <p role="status" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium">
            Zwei-Faktor-Anmeldung ist ausgeschaltet.
          </p>
        )}
        {pending && !reason && (
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
            Für dein Konto ist die Zwei-Faktor-Anmeldung <strong>Pflicht</strong>. Richte sie jetzt ein, um weiterzuarbeiten.
          </p>
        )}
        {reason === "aussen-code" && (
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
            Du bist <strong>außerhalb des Schulnetzes</strong>. Von hier geht es nur mit zweitem Faktor:{" "}
            {codeList ? "Gib einen Code von deiner Code-Liste ein." : "Melde dich ab und neu mit dem Code aus der Authenticator-App an."}
          </p>
        )}
        {reason === "aussen-code" && codeList && (
          <Card aria-label="Code-Liste">
            <CardHeader title="Code-Liste" />
            <CodeListForm />
          </Card>
        )}
        {reason === "aussen-ohne" && (
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
            Du bist <strong>außerhalb des Schulnetzes</strong>. Von hier geht es nur mit Zwei-Faktor-Anmeldung – richte sie in der Schule ein oder
            hol dir im Sekretariat eine Code-Liste.
          </p>
        )}
        {!pending && status.dueOn && !status.enabled && (
          <p role="note" className="rounded-xl border border-border bg-surface px-4 py-3 text-sm">
            Ab dem <strong>{dueText(status.dueOn)}</strong> ist die Zwei-Faktor-Anmeldung für dein Konto Pflicht. Richte sie am besten jetzt ein.
          </p>
        )}
        {sp.grund === "notenbuch" && !status.enabled && (
          <p role="note" className="rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
            Das <strong>Notenbuch</strong> öffnet sich nur mit Zwei-Faktor-Anmeldung (Noten sind besonders schützenswert). Richte sie hier ein und
            öffne das Notenbuch danach erneut.
          </p>
        )}
        {sp.grund === "notenbuch" && status.enabled && (
          <p className="text-sm">
            <Link href="/notenbuch" className="font-medium text-accent-ink hover:underline">
              Weiter zum Notenbuch
            </Link>
          </p>
        )}
        {status.required && !status.enforced && !status.enabled && (
          <p className="text-sm text-muted">In einer echten Schule wäre sie für dein Konto Pflicht; in dieser Demo ist sie freiwillig.</p>
        )}

        {reason === "aussen-code" ? null : (
          <>
            {status.totp ? (
              <>
                <Card aria-label="Wiederherstellungscodes">
                  <CardHeader title="Wiederherstellungscodes" />
                  <RegenerateCodesForm action={regenerateCodesAction} />
                </Card>
                <Card aria-label="Ausschalten">
                  <CardHeader title={status.passkeys > 0 ? "Code-App ausschalten" : "Ausschalten"} />
                  {status.enforced && status.passkeys === 0 ? (
                    <p className="text-sm text-muted">
                      Für dein Konto ist die Zwei-Faktor-Anmeldung Pflicht. Bei verlorenem Gerät ohne Codes setzt die Verwaltung sie zurück.
                    </p>
                  ) : (
                    <>
                      {status.passkeys > 0 && (
                        <p className="mb-3 text-sm text-muted">Die Anmeldung mit Sicherheitsschlüssel bleibt; nur Code-App und Wiederherstellungscodes fallen weg.</p>
                      )}
                      <DisableForm action={disableAction} />
                    </>
                  )}
                </Card>
              </>
            ) : (
              <Card aria-label="Einrichten">
                <CardHeader title={status.enabled ? "Code-App einrichten" : "Einrichten"} />
                {mayAdd ? (
                  <SetupPanel start={startSetupAction} confirm={sp.grund === "notenbuch" ? confirmSetupForNotenbuchAction : confirmSetupAction} />
                ) : (
                  <p role="note" className="text-sm text-muted">
                    {SETUP_BLOCKED_TEXT}
                  </p>
                )}
              </Card>
            )}
            <Card aria-label="Sicherheitsschlüssel">
              <CardHeader title="Sicherheitsschlüssel und Passkeys" />
              <p className="mb-4 text-sm text-muted">
                Statt (oder neben) der Code-App: ein USB-/NFC-Schlüssel, Windows Hello oder ein Passkey auf dem Handy. Bei der Anmeldung fragt
                SchulOS nach dem Passwort nach dem Schlüssel.
                {!status.totp && " Ohne Code-App gibt es keine Wiederherstellungscodes – richte am besten einen zweiten Schlüssel ein."}
              </p>
              <PasskeyPanel keys={keys} canAdd={mayAdd} blockedText={SETUP_BLOCKED_TEXT} grund={sp.grund} />
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
              Zurück zu SchulOS
            </Link>
          )}
        </div>
      </main>
    </SchoolTheme>
  );
}
