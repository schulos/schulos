import Link from "next/link";
import { requireModulePage } from "@/core/modules/guard";
import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";

/**
 * Öffentliche Schulanmeldung (P4-34) – ohne Konto erreichbar (src/core/public-paths.ts). Ausgeschaltetes Modul → 404 für
 * alle Seiten darunter. Immer hell, schlicht, mobil zuerst; Impressum und Datenschutzhinweise in jeder Fußzeile.
 */
export default async function AnmeldungPublicLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("anmeldung");
  const school = await getSchoolSettings();
  return (
    <div data-theme="light" className="flex min-h-dvh flex-col bg-surface text-ink">
      <header className="border-b border-border px-4 py-4">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <SchoolLogo logos={school.logos} name={school.name} className="h-10 max-w-[50%]" />
          <div className="min-w-0">
            <p className="truncate font-display text-lg font-bold">{school.name}</p>
            <p className="text-sm text-muted">Schulanmeldung</p>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</div>
      <footer className="border-t border-border px-4 py-4 text-sm">
        <nav aria-label="Rechtliches" className="mx-auto flex max-w-3xl flex-wrap gap-x-4 gap-y-1 text-muted">
          <Link href="/impressum" className="underline underline-offset-2 hover:text-ink">
            Impressum
          </Link>
          <Link href="/datenschutzhinweise" className="underline underline-offset-2 hover:text-ink">
            Datenschutzhinweise
          </Link>
          <Link href="/barrierefreiheit" className="underline underline-offset-2 hover:text-ink">
            Barrierefreiheit
          </Link>
          <Link href="/anmeldung" className="underline underline-offset-2 hover:text-ink">
            Alle Anmeldungen
          </Link>
        </nav>
      </footer>
    </div>
  );
}
