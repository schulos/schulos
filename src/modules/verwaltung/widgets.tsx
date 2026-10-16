import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { listAudit } from "./audit-view";
import { countByRole } from "./users";

const fmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

async function AufEinenBlick({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const canAudit = hasPermission(current.perms, "verwaltung.rights");
  const [byRole, audit] = await Promise.all([countByRole(db), canAudit ? listAudit(db, { page: 1 }) : null]);
  const stats = [
    { label: "Schüler:innen", value: byRole.schueler, href: "/verwaltung/benutzer?role=schueler" },
    { label: "Lehrkräfte", value: byRole.lehrkraft, href: "/verwaltung/benutzer?role=lehrkraft" },
    { label: "Eltern", value: byRole.eltern, href: "/verwaltung/benutzer?role=eltern" },
  ];
  return (
    <Card>
      <CardHeader title="Verwaltung auf einen Blick" action={{ href: "/verwaltung", label: "Öffnen" }} />
      <div className="grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="flex flex-col rounded-xl bg-surface-2 px-3 py-2.5 hover:ring-1 hover:ring-border-strong">
            <span className="font-display text-2xl font-bold tracking-tight">{s.value}</span>
            <span className="text-xs text-muted">{s.label}</span>
          </Link>
        ))}
      </div>
      {audit && audit.rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">Zuletzt geändert</span>
          <ul className="flex flex-col gap-1 text-sm">
            {audit.rows.slice(0, 4).map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span className="truncate">
                  {r.label}: <span className="text-muted">{r.target}</span>
                </span>
                <span className="shrink-0 text-muted tabular-nums">{fmt.format(r.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export const verwaltungWidgets: WidgetDef[] = [
  { id: "verwaltung.ueberblick", moduleId: "verwaltung", order: 10, requires: "verwaltung.access", Component: AufEinenBlick },
];
