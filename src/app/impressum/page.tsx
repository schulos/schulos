import type { Metadata } from "next";
import Link from "next/link";
import { getDb } from "@/core/db/client";
import { IMPRESSUM_FIELD_DEFS, readImpressum } from "@/core/school/impressum";
import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";
import { Button } from "@schulos/ui/button";

export const metadata: Metadata = { title: "Impressum" };
export const dynamic = "force-dynamic";

/**
 * Impressum (P4-33, Q5-22) – öffentlich, Pflicht für die öffentlichen Seiten (Schulanmeldung). Angaben pflegt die Schule
 * unter Verwaltung → Schule. Solange die Pflichtfelder unvollständig sind, steht hier der bisherige Freitext (falls vorhanden).
 */
export default async function ImpressumPage() {
  const [imp, school] = await Promise.all([readImpressum(await getDb()), getSchoolSettings()]);
  const f = imp.fields;
  const useLegacy = !imp.complete && imp.legacyText !== "";
  const hasFields = IMPRESSUM_FIELD_DEFS.some((d) => f[d.key]);
  const rows: [string, string][] = (
    [
      ["Rechtsform", f.legalForm],
      ["Vertreten durch", f.representedBy],
      ["Telefon", f.phone],
      ["Schulträger", f.schoolAuthority],
      ["Zuständige Aufsichtsbehörde", f.supervisoryAuthority],
      ["Registereintrag", f.register],
      ["Umsatzsteuer-Identifikationsnummer", f.vatId],
    ] as [string, string][]
  ).filter(([, v]) => v);
  return (
    <div data-theme="light" className="min-h-dvh bg-surface px-4 py-8 text-ink">
      <nav aria-label="Optionen" className="mx-auto mb-6 flex max-w-3xl flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">Zu SchulOS</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/datenschutzhinweise">Datenschutzhinweise</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/barrierefreiheit">Barrierefreiheit</Link>
        </Button>
      </nav>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 leading-relaxed">
        <header>
          <SchoolLogo logos={school.logos} name={school.name} className="mb-3 h-12 max-w-full" />
          <h1 className="font-display text-3xl font-bold tracking-tight">Impressum</h1>
        </header>
        {useLegacy ? (
          <p className="whitespace-pre-line" data-testid="impressum-text">
            {imp.legacyText}
          </p>
        ) : hasFields ? (
          <div data-testid="impressum-text" className="flex flex-col gap-4">
            <address className="not-italic">
              {f.name && <strong className="block">{f.name}</strong>}
              {f.street && <span className="block">{f.street}</span>}
              {(f.postalCode || f.city) && <span className="block">{[f.postalCode, f.city].filter(Boolean).join(" ")}</span>}
            </address>
            {(rows.length > 0 || f.email) && (
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                {rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-medium">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
                {f.email && (
                  <div className="contents">
                    <dt className="font-medium">E-Mail</dt>
                    <dd>
                      <a href={`mailto:${f.email}`} className="text-accent-ink underline underline-offset-2">
                        {f.email}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            )}
            {f.additional && <p className="whitespace-pre-line">{f.additional}</p>}
          </div>
        ) : (
          <p className="text-muted italic">{school.name} hat ihre Angaben noch nicht eingetragen.</p>
        )}
      </main>
    </div>
  );
}
