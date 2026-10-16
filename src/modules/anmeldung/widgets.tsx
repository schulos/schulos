import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { widgetSummary } from "./sekretariat";

/** „Neue Anmeldungen“ (P4-36): je laufendem Verfahren bestätigte, noch nicht vollständige Anträge und Gespräche heute. */
async function NeueAnmeldungen({ current }: { current: CurrentUser }) {
  const list = await widgetSummary(await getDb(), current.perms, toBerlinDate(new Date()));
  return (
    <Card aria-label="Neue Anmeldungen">
      <CardHeader title="Neue Anmeldungen" action={{ href: "/verwaltung/anmeldung", label: "Schulanmeldung" }} />
      {list.length === 0 ? (
        <p className="text-sm text-muted">Kein Anmeldeverfahren läuft.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((v) => (
            <li key={v.id}>
              <Link href={`/verwaltung/anmeldung/${v.id}/antraege`} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 hover:ring-1 hover:ring-border-strong">
                <span className="min-w-0 truncate text-sm font-medium">{v.name}</span>
                <span className="flex shrink-0 gap-4 text-right">
                  <span className="flex flex-col">
                    <span className="font-display text-xl font-bold" data-testid="anmeldung-offen">
                      {v.open}
                    </span>
                    <span className="text-xs text-muted">offen</span>
                  </span>
                  <span className="flex flex-col">
                    <span className="font-display text-xl font-bold">{v.today}</span>
                    <span className="text-xs text-muted">Gespräche heute</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const anmeldungWidgets: WidgetDef[] = [{ id: "anmeldung.neu", moduleId: "anmeldung", order: 14, requires: "anmeldung.manage", Component: NeueAnmeldungen }];
