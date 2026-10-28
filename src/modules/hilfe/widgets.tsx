import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { STAFF_ROLES } from "@/core/roles";
import { toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Card, CardHeader } from "@schulos/ui/card";
import { canEditAll, dueForReview } from "./service";

const day = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmtDay = (ymd: string) => day.format(new Date(`${ymd}T12:00:00Z`));

/** HB-03/HB-04: für Pflegende alle fälligen Überprüfungen, für Ansprechpersonen die eigenen – sonst kein Widget. */
async function Ueberpruefung({ current }: { current: CurrentUser }) {
  const items = await dueForReview(await getDb(), current.perms, toBerlinDate(new Date()));
  if (items.length === 0) return null;
  const editor = canEditAll(current.perms);
  return (
    <Card>
      <CardHeader title="Handbuch: Überprüfung fällig" action={{ href: "/hilfe", label: "Zum Handbuch" }} />
      <ul className="flex flex-col gap-1">
        {items.map((p) => (
          <li key={p.id}>
            <Link href={`/hilfe/${p.slug}`} className="flex flex-col rounded-xl px-2 py-2 hover:bg-surface-2">
              <span className="truncate font-medium">{p.title}</span>
              <span className="truncate text-xs text-muted">
                fällig seit {fmtDay(p.dueOn)}
                {editor && ` · ${p.contactName ?? "ohne Ansprechperson"}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const hilfeWidgets: WidgetDef[] = [{ id: "hilfe.ueberpruefung", moduleId: "hilfe", order: 80, roles: [...STAFF_ROLES], Component: Ueberpruefung }];
