import { getSchoolSettings } from "@/core/settings";
import { SchoolLogo } from "@/ui/school-logo";

/**
 * Gemeinsamer Kopf aller Druckansichten (P4-05, Q-11): Schullogo, Titel, rechts Schulname und Stand.
 * Druckseiten sind immer hell (`data-theme="light"`) – das Logo erscheint dort ohne Platte.
 */
export async function DruckKopf({
  title,
  eyebrow,
  subtitle,
  stamp,
}: {
  title: React.ReactNode;
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** z. B. „gedruckt am 10.10.2026“ oder „Stand 10.10.2026, 08:15 Uhr“ */
  stamp: React.ReactNode;
}) {
  const school = await getSchoolSettings();
  return (
    <header className="flex items-end justify-between gap-4 border-b-2 border-ink pb-2">
      <div className="flex min-w-0 items-end gap-4">
        <SchoolLogo logos={school.logos} name={school.name} className="h-12 max-w-[70mm]" />
        <div className="min-w-0">
          {eyebrow && <p className="text-xs">{eyebrow}</p>}
          <h1 className="font-display text-2xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm">{subtitle}</p>}
        </div>
      </div>
      <p className="shrink-0 text-right text-xs">
        {school.name}
        <br />
        {stamp}
      </p>
    </header>
  );
}
