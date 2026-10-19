// Schulbücherei – Widgets für „Heute“ (BU-04): „Meine Ausleihen“ (eigene bzw. für Eltern die der Kinder, nur Aktuelles) und
// „Mahnliste“ fürs Büchereiteam (Mahnstufen nur für Erwachsene im Team).
import Link from "next/link";
import type { CurrentUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import type { WidgetDef } from "@/core/widgets";
import { Badge } from "@schulos/ui/badge";
import { Card, CardHeader } from "@schulos/ui/card";
import { canUse, childrenLibrary, myLibrary, type Library } from "./katalog";
import { canSeeDunningLevels, dunningList } from "./mahnungen";

const shortFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const short = (ymd: string) => shortFmt.format(new Date(`${ymd}T00:00:00Z`));

/** Höchstens so viele Zeilen je Person im Widget. */
const WIDGET_ROWS = 4;

function Loans({ lib }: { lib: Library }) {
  const ready = lib.reservations.filter((r) => r.readyOn);
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {lib.loans.slice(0, WIDGET_ROWS).map((l) => (
        <li key={l.id} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{l.title}</span>
          {l.overdue ? (
            <Badge tone="danger">{l.dunningLevel > 0 ? `${l.dunningLevel}. Mahnung` : "überfällig"}</Badge>
          ) : (
            <span className="shrink-0 text-muted tabular-nums">bis {short(l.dueOn)}</span>
          )}
        </li>
      ))}
      {lib.loans.length > WIDGET_ROWS && <li className="text-xs text-muted">und {lib.loans.length - WIDGET_ROWS} weitere</li>}
      {ready.map((r) => (
        <li key={r.id} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{r.title}</span>
          <Badge tone="success">liegt bereit{r.holdUntil ? ` bis ${short(r.holdUntil)}` : ""}</Badge>
        </li>
      ))}
    </ul>
  );
}

const hasContent = (lib: Library) => lib.loans.length > 0 || lib.reservations.some((r) => r.readyOn);

/** „Meine Ausleihen“: offene Ausleihen mit Fälligkeit/Mahnstufe und bereitliegende Vormerkungen – ohne etwas offen: nichts. */
async function MeineAusleihen({ current }: { current: CurrentUser }) {
  const db = await getDb();
  const today = toBerlinDate(new Date());
  if (canUse(current.perms)) {
    const lib = await myLibrary(db, current.perms, today);
    if (!hasContent(lib)) return null;
    return (
      <Card aria-label="Meine Ausleihen">
        <CardHeader title="Meine Ausleihen" action={{ href: "/buecherei/meine", label: "Alle ansehen" }} />
        <Loans lib={lib} />
      </Card>
    );
  }
  const kids = (await childrenLibrary(db, current.perms, today)).filter(hasContent);
  if (!kids.length) return null;
  return (
    <Card aria-label="Ausleihen meiner Kinder">
      <CardHeader title="Bücherei: Ausleihen meiner Kinder" action={{ href: "/buecherei/meine", label: "Alle ansehen" }} />
      {kids.map((k) => (
        <section key={k.id} aria-label={k.name} className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{k.name}</h3>
          <Loans lib={k} />
        </section>
      ))}
    </Card>
  );
}

/** „Mahnliste“ (Recht `buecherei.desk`): Zahl der Überfälligen (je Stufe für Erwachsene) und die am längsten überfälligen. */
async function Mahnliste({ current }: { current: CurrentUser }) {
  const rows = await dunningList(await getDb(), current.perms, toBerlinDate(new Date()));
  const levels = canSeeDunningLevels(current.perms);
  const byLevel = [1, 2, 3].map((n) => rows.filter((r) => r.dunningLevel === n).length);
  return (
    <Card aria-label="Mahnliste">
      <CardHeader title="Bücherei: Mahnliste" action={{ href: "/buecherei/mahnliste", label: "Zur Mahnliste" }} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nichts überfällig.</p>
      ) : (
        <>
          <p className="text-sm">
            <span className="font-semibold">{rows.length === 1 ? "1 Ausleihe" : `${rows.length} Ausleihen`} überfällig</span>
            {levels && byLevel.some(Boolean) && <span className="text-muted"> · {byLevel.map((n, i) => (n ? `${n}× ${i + 1}. Mahnung` : null)).filter(Boolean).join(", ")}</span>}
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {rows.slice(0, 5).map((r) => (
              <li key={r.loanId} className="flex items-baseline justify-between gap-3">
                {r.userId && r.name ? (
                  <Link href={`/buecherei/theke?person=${encodeURIComponent(r.userId)}`} className="min-w-0 truncate hover:underline">
                    {r.name}
                    {r.className ? ` (${r.className})` : ""}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-muted">Konto gelöscht</span>
                )}
                <span className="shrink-0 text-muted tabular-nums">{r.overdueDays === 1 ? "1 Tag" : `${r.overdueDays} Tage`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export const buechereiWidgets: WidgetDef[] = [
  { id: "buecherei.mahnliste", moduleId: "buecherei", order: 30, requires: "buecherei.desk", Component: Mahnliste },
  { id: "buecherei.meine", moduleId: "buecherei", order: 65, requires: "buecherei.use", Component: MeineAusleihen },
  { id: "buecherei.kinder", moduleId: "buecherei", order: 65, roles: ["eltern"], Component: MeineAusleihen },
];
