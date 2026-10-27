import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { requireModulePage } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { PLAN_FORECAST, PLAN_MANAGE, PLAN_SUBSTITUTE } from "@/modules/stundenplan/rechte";
import { SubNav } from "@schulos/ui/sub-nav";

/**
 * SP-03 (docs/STUNDENPLAN-UMBAU.md §2.3): eigener Bereich „Stundenplanung“ statt Reiter in der Verwaltung. Zugang nur mit einem der
 * beiden Planungsrechte (sonst 404) – `verwaltung.access` ist nicht nötig. Die Seiten prüfen ihr Recht zusätzlich selbst.
 * SP2-12: auch mit „Fachbedarf einsehen“ (Schulleitung) – dann nur Übersicht und Fachbedarf (Summen je Fach).
 */
export default async function PlanungLayout({ children }: { children: React.ReactNode }) {
  await requireModulePage("stundenplan");
  const { perms } = await requireUser();
  const manage = hasPermission(perms, PLAN_MANAGE);
  const substitute = hasPermission(perms, PLAN_SUBSTITUTE);
  const forecast = hasPermission(perms, PLAN_FORECAST);
  if (!manage && !substitute && !forecast) notFound();
  const tabs = [
    { href: "/planung", label: "Übersicht" },
    manage && { href: "/planung/stundenplan", label: "Stundenplan" },
    manage && { href: "/planung/unterricht", label: "Unterrichtsverteilung" },
    manage && { href: "/planung/zeitwuensche", label: "Zeitwünsche" },
    manage && { href: "/planung/solver", label: "Automatisch planen" },
    // SP3-01: Planversionen (Entwürfe, Varianten, gültige und archivierte Versionen)
    manage && { href: "/planung/versionen", label: "Versionen" },
    (manage || forecast) && { href: "/planung/bedarf", label: "Fachbedarf" },
    substitute && { href: "/planung/vertretungen", label: "Vertretungen" },
    (manage || substitute) && { href: "/planung/aufsichten", label: "Aufsichten" },
  ].filter((t): t is { href: string; label: string } => Boolean(t));
  return (
    <div className="flex flex-col gap-6">
      <SubNav tabs={tabs} label="Stundenplanung" root="/planung" />
      {children}
    </div>
  );
}
