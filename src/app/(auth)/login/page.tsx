import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDemoAccounts, isDemoInstance, previewVersion } from "@/core/auth/demo";
import { getCurrentUser } from "@/core/auth/session";
import { EXTERNAL_LOGIN_HINT, externalZone } from "@/core/external-access";
import { mailAvailable } from "@/core/mail";
import { getSchoolSettings } from "@/core/settings";
import { sourceInfo } from "@/core/source";
import { safeNext } from "@schulos/server/safe-next";
import { DemoBand, Logo } from "@schulos/ui/misc";
import { SchoolLogo } from "@/ui/school-logo";
import { SchoolTheme } from "@/ui/school-theme";
import { ClearAppCaches } from "@/ui/pwa";
import { DemoPicker } from "./demo-picker";
import { LoginForm } from "@schulos/ui/auth-forms";
import { loginAction } from "./actions";

export const metadata: Metadata = { title: "Anmelden" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const [{ next }, school, demo, demoInstance, zone] = await Promise.all([searchParams, getSchoolSettings(), getDemoAccounts(), isDemoInstance(), headers().then(externalZone)]);
  const source = sourceInfo();
  return (
    <SchoolTheme>
      {/* P4-73: Reste der PWA-Caches einer beendeten Sitzung wegräumen */}
      <ClearAppCaches />
      {demoInstance && <DemoBand preview={previewVersion()} />}
      <main className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
        <div className="flex w-full max-w-4xl flex-wrap items-start justify-center gap-6">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-card">
            {/* Schullogo (P4-04) über dem Kopf; ohne Logo wie bisher SchulOS-Zeichen + Schulname */}
            <SchoolLogo logos={school.logos} name={school.name} className="mb-5 h-16 max-w-full" />
            <div className="mb-8 flex items-center gap-3">
              {!school.logos.logo && !school.logos.symbol && <Logo />}
              <div>
                <h1 className="font-display text-xl font-bold tracking-tight">SchulOS</h1>
                <p className="text-xs text-muted">{school.name}</p>
              </div>
            </div>
            {/* P4-40b: von außen vorab erklären, wer sich hier anmelden kann – die Ablehnung selbst sagt nur „falsch“ */}
            {zone !== "intern" && (
              <p role="note" className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                {EXTERNAL_LOGIN_HINT}
              </p>
            )}
            <LoginForm action={loginAction} next={safeNext(next)} />
            {/* Q-4E-31: mit dem Quellcode-Link umbricht die Zeile – je Link mind. 24 px hoch (axe target-size, WCAG 2.5.8) */}
            <p className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-1 text-center text-xs text-muted [&>a]:inline-flex [&>a]:min-h-6 [&>a]:items-center">
              {/* P4-70: nur mit Mailversand – der Link geht nur an Konten mit 2FA und bestätigter Adresse */}
              {mailAvailable() && (
                <Link href="/passwort-vergessen" className="hover:underline">
                  Passwort vergessen?
                </Link>
              )}
              <Link href="/datenschutzhinweise" className="hover:underline">
                Datenschutzhinweise
              </Link>
              {/* A11Y-02 */}
              <Link href="/barrierefreiheit" className="hover:underline">
                Barrierefreiheit
              </Link>
              {/* AGPL § 13 (Q-4E-31): Quellcode anbieten */}
              <a href={source.href} rel="noopener noreferrer" target="_blank" className="hover:underline">
                Quellcode (AGPL) · {source.version}
              </a>
            </p>
          </div>
          {demo.length > 0 && (
            <section aria-labelledby="demo-title" className="w-full max-w-sm rounded-2xl border border-dashed border-border-strong p-6">
              <h2 id="demo-title" className="font-semibold">
                Demo: Ansicht als …
              </h2>
              <p className="mb-4 text-sm text-muted">Ein Klick meldet dich direkt mit diesem Demo-Konto an.</p>
              <DemoPicker accounts={demo} />
            </section>
          )}
        </div>
      </main>
    </SchoolTheme>
  );
}
