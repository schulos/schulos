import Link from "next/link";
import { getDemoAccounts, isDemoInstance, previewVersion } from "@/core/auth/demo";
import { requireUser } from "@/core/auth/session";
import { getSchoolSettings } from "@/core/settings";
import { getShellData } from "@/core/shell";
import { DemoBand, Logo } from "@schulos/ui/misc";
import { SchoolLogo } from "@/ui/school-logo";
import { SchoolTheme } from "@/ui/school-theme";
import { PwaRegister } from "@/ui/pwa";
import { MobileTabBar, SidebarNav } from "./_shell/nav";
import { CommandPalette } from "./_shell/palette";
import { DisclaimerBand } from "./_shell/disclaimer";
import { Gong } from "./_shell/gong";
import { HelpButton } from "./_shell/help-button";
import { LiveEvents } from "./_shell/live";
import { SearchButton } from "./_shell/topbar";
import { UserMenu } from "./_shell/user-menu";
import { ISSUE_ROLES, issueLink, sourceLink } from "@/core/source";

export const dynamic = "force-dynamic";

const dateDe = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const current = await requireUser();
  const [shell, school, demoAccounts, demo] = await Promise.all([getShellData(current), getSchoolSettings(), getDemoAccounts(), isDemoInstance()]);

  return (
    <>
      {/* A11Y-01g: Sprungmarke für Tastatur und Screenreader – erstes Ziel der Tab-Taste, sichtbar erst mit Fokus */}
      <a
        href="#inhalt"
        className="sr-only z-50 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      {demo && <DemoBand preview={previewVersion()} />}
      <DisclaimerBand perms={current.perms} demo={demo} />
      <SchoolTheme className="min-h-dvh bg-ground lg:flex">
        <aside aria-label="Seitenleiste" className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-4 py-6 lg:flex">
          {school.logos.logo ? (
            // Schullogo (P4-04): quer mit Schriftzug, darunter klein Plattform und Schulname
            <Link href="/" className="flex flex-col items-start gap-1.5 px-2" aria-label={`SchulOS · ${school.name} – Startseite`}>
              <SchoolLogo logos={school.logos} name={school.name} className="h-12 max-w-full" />
              <span className="max-w-full truncate text-xs text-muted">SchulOS · {school.name}</span>
            </Link>
          ) : (
            <Link href="/" className="flex items-center gap-3 px-2">
              <SchoolLogo logos={school.logos} name={school.name} prefer="symbol" className="size-9" fallback={<Logo />} />
              <span className="flex min-w-0 flex-col">
                <span className="font-display text-xl leading-tight font-bold tracking-tight">SchulOS</span>
                <span className="truncate text-xs text-muted">{school.name}</span>
              </span>
            </Link>
          )}
          <SidebarNav groups={shell.nav} badges={shell.badges} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-border bg-ground/90 px-4 py-3 backdrop-blur sm:px-6 lg:border-none lg:px-10 lg:pt-5">
            <Link href="/" className="lg:hidden" aria-label="SchulOS – Startseite">
              <SchoolLogo logos={school.logos} name={school.name} prefer="symbol" className="h-8 max-w-28" fallback={<Logo className="size-8" />} />
            </Link>
            <SearchButton />
            <div className="ml-auto flex items-center gap-2">
              {shell.help && <HelpButton />}
              <Gong initialUnread={shell.unread} />
              <UserMenu user={shell.user} userId={current.perms.userId} demoAccounts={demoAccounts} source={sourceLink()}
                issue={ISSUE_ROLES.includes(current.user.role) ? issueLink() : undefined}
              />
            </div>
          </header>
          <div id="inhalt" tabIndex={-1} className="flex-1 px-4 pt-6 pb-28 outline-none sm:px-6 lg:px-10 lg:pb-12">
            {/* SEC-01: Übergangsfrist – Hinweis statt Sperre bis zum Stichtag der Schule */}
            {current.perms.twoFactorDueOn && (
              <p role="note" data-testid="zwei-faktor-frist" className="mb-6 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-sm">
                Ab dem <strong>{dateDe(current.perms.twoFactorDueOn)}</strong> ist die Zwei-Faktor-Anmeldung für dein Konto Pflicht.{" "}
                <Link href="/zwei-faktor" className="font-medium text-accent-ink hover:underline">
                  Jetzt einrichten
                </Link>
              </p>
            )}
            {children}
          </div>
        </div>

        <MobileTabBar groups={shell.nav} badges={shell.badges} />
        <LiveEvents />
        <PwaRegister />
        <CommandPalette groups={shell.nav} userId={current.perms.userId} />
      </SchoolTheme>
    </>
  );
}
