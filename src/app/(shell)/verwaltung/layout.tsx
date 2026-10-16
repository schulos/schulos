import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { moduleOn } from "@/core/modules/guard";
import { hasPermission } from "@/core/permissions";
import { SubNav } from "./sub-nav";

export default async function VerwaltungLayout({ children }: { children: React.ReactNode }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.access")) notFound();
  const gebaeude = hasPermission(perms, "gebaeude.configure") && (await moduleOn("gebaeude"));
  const anmeldung =
    (hasPermission(perms, "anmeldung.view") || hasPermission(perms, "anmeldung.manage") || hasPermission(perms, "anmeldung.decide")) && (await moduleOn("anmeldung"));
  const tabs = [
    { href: "/verwaltung", label: "Übersicht" },
    hasPermission(perms, "verwaltung.school") && { href: "/verwaltung/schule", label: "Schule" },
    hasPermission(perms, "verwaltung.school") && { href: "/verwaltung/stammdaten", label: "Stammdaten" },
    hasPermission(perms, "verwaltung.users") && { href: "/verwaltung/benutzer", label: "Benutzer" },
    hasPermission(perms, "verwaltung.groups") && { href: "/verwaltung/gruppen", label: "Gruppen" },
    hasPermission(perms, "verwaltung.rights") && { href: "/verwaltung/rechte", label: "Rechte & Module" },
    hasPermission(perms, "verwaltung.users") && { href: "/verwaltung/import", label: "Import" },
    hasPermission(perms, "stundenplan.manage") && { href: "/verwaltung/stundenplan", label: "Stundenplan" },
    hasPermission(perms, "stundenplan.manage") && { href: "/verwaltung/unterricht", label: "Unterrichtsverteilung" },
    hasPermission(perms, "stundenplan.manage") && { href: "/verwaltung/vertretungen", label: "Vertretungen" },
    hasPermission(perms, "stundenplan.manage") && { href: "/verwaltung/aufsichten", label: "Aufsichten" },
    hasPermission(perms, "monitor.manage") && { href: "/verwaltung/monitore", label: "Monitore" },
    gebaeude && { href: "/verwaltung/gebaeude", label: "Gebäude & Technik" },
    anmeldung && { href: "/verwaltung/anmeldung", label: "Schulanmeldung" },
    hasPermission(perms, "verwaltung.rights") && { href: "/verwaltung/protokoll", label: "Protokoll" },
    hasPermission(perms, "verwaltung.privacy") && { href: "/verwaltung/schuljahreswechsel", label: "Schuljahreswechsel" },
    hasPermission(perms, "verwaltung.system") && { href: "/verwaltung/backup", label: "Backup" },
    hasPermission(perms, "verwaltung.system") && { href: "/verwaltung/system", label: "System" },
    { href: "/verwaltung/datenschutz", label: "Datenschutz" },
  ].filter((t): t is { href: string; label: string } => Boolean(t));
  return (
    <div className="flex flex-col gap-6">
      <SubNav tabs={tabs} />
      {children}
    </div>
  );
}
