import { and, asc, eq, inArray } from "drizzle-orm";
import type { CurrentUser } from "@/core/auth/session";
import type { WidgetDef } from "@/core/widgets";
import { getDb } from "@/core/db/client";
import { groupMembers, groups, parentChild, users } from "@/core/db/schema";
import { parentInformedSql } from "@/core/school/majority";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { Avatar, initials } from "@schulos/ui/misc";
import { de } from "@/core/db/sort";
import Link from "next/link";
import { loadModuleStates } from "@/core/modules/registry";
import { collectOpenItems, type OpenItem } from "@/core/open-items";
import { MODULES } from "@/modules";
import { OPEN_ITEM_PROVIDERS } from "@/modules/open-items";
import { remindLetterAction } from "@/modules/elternbriefe/actions";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";

async function MeineGruppen({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const rows = await db
    .select({ id: groups.id, name: groups.name, kind: groups.kind, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, current.user.id))
    .orderBy(asc(groups.kind), de(groups.name));
  return (
    <Card>
      <CardHeader title="Meine Gruppen" />
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Du bist noch in keiner Gruppe.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, 8).map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{g.name}</span>
              <span className="flex shrink-0 gap-1.5">
                {g.role === "leader" && <Badge tone="soft">Leitung</Badge>}
                <Badge>{GROUP_KIND_LABELS[g.kind]}</Badge>
              </span>
            </li>
          ))}
          {rows.length > 8 && <li className="text-sm text-muted">… und {rows.length - 8} weitere</li>}
        </ul>
      )}
    </Card>
  );
}

async function MeineKinder({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const kids = await db
    .select({ id: users.id, name: users.name })
    .from(parentChild)
    .innerJoin(users, eq(users.id, parentChild.childId))
    // Q5-05: eigenständige Kinder nur mit deren Einwilligung
    .where(and(eq(parentChild.parentId, current.user.id), parentInformedSql()))
    .orderBy(de(users.firstName));
  const classes = kids.length
    ? await db
        .select({ userId: groupMembers.userId, name: groups.name })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .where(and(inArray(groupMembers.userId, kids.map((k) => k.id)), eq(groups.kind, "klasse")))
    : [];
  return (
    <Card>
      <CardHeader title={kids.length === 1 ? "Mein Kind" : "Meine Kinder"} />
      <ul className="flex flex-col gap-3">
        {kids.map((k) => (
          <li key={k.id} className="flex items-center gap-3">
            <Avatar label={initials(k.name)} tone="soft" />
            <span className="flex flex-col leading-tight">
              <span className="font-medium">{k.name}</span>
              <span className="text-sm text-muted">{classes.filter((c) => c.userId === k.id).map((c) => c.name).join(", ")}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const TONE_BADGE = { danger: "danger", warn: "warn", info: "soft" } as const;

/**
 * Q5-07 (I-10, I-27): offene Handgriffe aus allen Modulen – nur Zähler und eigene Vorgänge (Lieferanten in
 * src/modules/open-items.ts). Nichts offen → kurzer Hinweis statt leerer Karte.
 */
async function OffenFuerDich({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const items = await collectOpenItems(db, current, OPEN_ITEM_PROVIDERS, MODULES, await loadModuleStates(db));
  return (
    <Card aria-label="Offen für dich">
      <CardHeader title="Offen für dich" />
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nichts offen – alles erledigt.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((i: OpenItem) => (
            <li key={i.id} data-open-item={i.id} className="flex items-center gap-2">
              <Link href={i.href} className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-surface-2">
                <span className="flex min-w-0 flex-col">
                  <span className={cn("truncate font-medium", i.tone === "danger" && "text-danger")}>{i.label}</span>
                  {i.detail && <span className="truncate text-xs text-muted">{i.detail}</span>}
                </span>
                {i.count !== undefined && <Badge tone={TONE_BADGE[i.tone]}>{i.count}</Badge>}
              </Link>
              {i.remindLetterId && (
                <form action={remindLetterAction.bind(null, i.remindLetterId)}>
                  <Button type="submit" size="sm" variant="ghost" aria-label={`Erinnern: ${i.label}`}>
                    Erinnern
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export const heuteWidgets: WidgetDef[] = [
  { id: "heute.offen", moduleId: "heute", order: 3, roles: ["eltern", "schueler", "lehrkraft", "verwaltung", "admin"], Component: OffenFuerDich },
  { id: "heute.kinder", moduleId: "heute", order: 5, roles: ["eltern"], Component: MeineKinder },
  { id: "heute.gruppen", moduleId: "heute", order: 90, roles: ["schueler", "lehrkraft", "verwaltung"], Component: MeineGruppen },
];

