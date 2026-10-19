import type { Metadata } from "next";
import Link from "next/link";
import { eq, inArray } from "drizzle-orm";
import { Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { groupMembers } from "@/core/db/schema";
import { childrenOf } from "@/core/school/majority";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { planDays, substitutionsOn, type DaySubstitution } from "@/modules/stundenplan/vertretung";
import { draftDays } from "@/modules/stundenplan/freigabe";
import { hasPermission } from "@/core/permissions";
import { AutoRefresh } from "@schulos/ui/auto-refresh";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Vertretungsplan" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const KIND_LABEL = { cancel: "Entfall", substitute: "Vertretung", room: "Raumänderung" } as const;

/** Gruppen des Betrachters (Eltern: die ihrer Kinder) – werden oben und markiert gezeigt. */
async function myGroups(userId: string, role: string): Promise<Set<string>> {
  const db = await getDb();
  let ids = [userId];
  // Q5-05: Kinder, über die die Eltern informiert werden (eigenständige nur mit deren Einwilligung)
  if (role === "eltern") ids = (await childrenOf(db, userId, "inform")).map((r) => r.id);
  if (ids.length === 0) return new Set();
  const rows = await db.select({ g: groupMembers.groupId }).from(groupMembers).where(inArray(groupMembers.userId, ids));
  return new Set(rows.map((r) => r.g));
}

function DayPlan({ date, today, entries, mine }: { date: string; today: string; entries: DaySubstitution[]; mine: Set<string> }) {
  const groups = [...new Set(entries.map((e) => e.groupId))].sort((a, b) => Number(mine.has(b)) - Number(mine.has(a)));
  return (
    <section aria-labelledby={`tag-${date}`} className="flex flex-col gap-3">
      <h2 id={`tag-${date}`} className="font-display text-xl font-bold">
        {date === today ? "Heute · " : ""}
        {longDay.format(fromBerlinLocal(date))}
      </h2>
      {groups.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-muted">Keine Änderungen.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const rows = entries.filter((e) => e.groupId === g);
            return (
              <article key={g} aria-label={rows[0]!.groupName} className={cn("flex flex-col gap-2 rounded-card border border-border bg-surface p-4", mine.has(g) && "border-2 border-accent")}>
                <header className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{rows[0]!.groupName}</h3>
                  {mine.has(g) && <Badge tone="soft">Deine Klasse</Badge>}
                </header>
                <ul className="flex flex-col gap-2">
                  {rows.map((e) => (
                    <li key={e.id} className="flex gap-3">
                      <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{e.periodNr}.</span>
                      <span aria-hidden className="w-1 shrink-0 self-stretch rounded-full" style={{ background: e.color }} />
                      <span className="flex min-w-0 flex-col">
                        <span className={cn("font-medium", e.kind === "cancel" && "text-muted line-through")}>
                          {e.subjectName} <span className="font-normal text-muted">({e.teacherCode})</span>
                        </span>
                        <span className={cn("text-sm font-semibold", e.kind === "cancel" ? "text-muted" : "text-warn")}>
                          {KIND_LABEL[e.kind]}
                          {e.kind === "substitute" && e.substituteName && ` · ${e.substituteName}`}
                          {e.newRoomId && ` · Raum ${e.newRoomId}`}
                        </span>
                        {e.note && <span className="text-sm text-muted">{e.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default async function VertretungsplanPage() {
  const { user, perms } = await requireUser();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const days = planDays(today, await loadSchoolCalendar(db));
  // Q5-11: hier steht immer der veröffentlichte Stand (wie für alle); die Planung bekommt einen Hinweis auf Entwürfe
  const [entries, mine, drafts] = await Promise.all([
    substitutionsOn(db, days),
    myGroups(user.id, user.role),
    hasPermission(perms, "stundenplan.substitute") ? draftDays(db, days) : Promise.resolve(new Set<string>()),
  ]);

  return (
    <main className="flex flex-col gap-7">
      <AutoRefresh />
      <PageHeader
        eyebrow="Stundenplan"
        title="Vertretungsplan"
        actions={
          <>
            <Button asChild>
              <Link href="/druck/vertretungsplan">
                <Printer aria-hidden /> Drucken
              </Link>
            </Button>
            <Button asChild>
              <Link href="/stundenplan">Wochenplan</Link>
            </Button>
          </>
        }
      />
      {drafts.size > 0 && (
        <p role="note" className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          Entwurf für {[...drafts].map((d) => longDay.format(fromBerlinLocal(d))).join(" und ")} noch nicht veröffentlicht – hier steht, was alle sehen.{" "}
          <Link href={`/planung/vertretungen?datum=${[...drafts][0]}`} className="font-semibold underline">
            Zum Entwurf
          </Link>
        </p>
      )}
      {entries.length === 0 && <EmptyState title="Keine Vertretungen">Für heute und den nächsten Schultag ist nichts geändert.</EmptyState>}
      {entries.length > 0 && days.map((d) => <DayPlan key={d} date={d} today={today} entries={entries.filter((e) => e.date === d)} mine={mine} />)}
    </main>
  );
}
