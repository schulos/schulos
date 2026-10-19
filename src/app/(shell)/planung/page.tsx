import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { hasPermission } from "@/core/permissions";
import { PLAN_MANAGE, PLAN_SUBSTITUTE, PLANNING_GROUP } from "@/modules/stundenplan/rechte";
import { PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Stundenplanung" };

type Area = { href: string; title: string; text: string };

/**
 * SP-03: Einstieg in den Bereich – vorerst Wegweiser zu den Reitern. Die Übersicht mit Kennzahlen (offene Lehraufträge,
 * Vertretungsbedarf, letzter Solver-Lauf …) folgt in SP-04.
 */
export default async function PlanungPage() {
  const { perms } = await requireUser();
  const manage = hasPermission(perms, PLAN_MANAGE);
  const substitute = hasPermission(perms, PLAN_SUBSTITUTE);
  const areas: Area[] = [
    ...(manage
      ? [
          { href: "/planung/stundenplan", title: "Stundenplan", text: "Stunden setzen, verschieben, koppeln und fixieren; Periode kopieren" },
          { href: "/planung/unterricht", title: "Unterrichtsverteilung", text: "Lehraufträge, Lehrkräfte und Deputate, Diagnose" },
          { href: "/planung/zeitwuensche", title: "Zeitwünsche", text: "Wünsche und Sperrzeiten, Eingabefenster für Lehrkräfte" },
          { href: "/planung/solver", title: "Automatisch planen", text: "Planvorschlag berechnen und ab Stichtag übernehmen" },
        ]
      : []),
    ...(substitute
      ? [{ href: "/planung/vertretungen", title: "Vertretungen", text: "Abwesenheiten, Vertretungsbedarf, Vorschläge, Veröffentlichen, Statistik" }]
      : []),
    { href: "/planung/aufsichten", title: "Aufsichten", text: manage ? "Aufsichtsbereiche, Wochenplan und Tagesansicht" : "Tagesansicht und Aufsichtsvertretung" },
    { href: "/stundenplan/raeume", title: "Räume", text: "Belegung, freie Räume und Raumsperren" },
  ];
  return (
    <main className="flex flex-col gap-7">
      <PageHeader eyebrow="Organisation" title="Stundenplanung" />
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {areas.map((a) => (
          <li key={a.href}>
            <Link
              href={a.href}
              className="flex h-full flex-col gap-1 rounded-card border border-border bg-surface p-4 transition hover:border-border-strong"
            >
              <span className="font-semibold">{a.title}</span>
              <span className="text-sm text-muted">{a.text}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p role="note" className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">
        Wer plant, gehört zur Gruppe „{PLANNING_GROUP.name}“ (beide Planungsrechte). Mitglieder trägt nur ein, wer beide Rechte selbst
        hat – auf einer neuen Installation die Administration unter Verwaltung → Gruppen. Nur „Vertretungen planen“ (z. B. fürs
        Sekretariat) kann unter Verwaltung → Rechte & Module auch einer Rolle gegeben werden. Stammdaten wie Fächer, Räume und
        Zeitraster pflegt die Verwaltung.
      </p>
    </main>
  );
}
