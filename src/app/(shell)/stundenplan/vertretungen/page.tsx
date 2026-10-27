import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import { Printer } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { groupMembers } from "@/core/db/schema";
import { childrenOf } from "@/core/school/majority";
import { isStaffRole } from "@/core/roles";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { acknowledgeSubstitutionAction } from "@/modules/stundenplan/actions";
import { CHANGE_MARKER_LABEL, changeLabel, changeOff, changeRoomShift, changeTeacher, reasonLabel, subjectLabel } from "@/modules/stundenplan/display";
import { markerSinceDb } from "@/modules/stundenplan/benachrichtigung";
import { materialsFor } from "@/modules/stundenplan/selbstmeldung";
import { dayNotesOn, type DayNote } from "@/modules/stundenplan/tagesmitteilungen";
import { acknowledgeEnabled, ownSubstitutions, planDays, substitutionsOn, type DaySubstitution } from "@/modules/stundenplan/vertretung";
import { draftDays } from "@/modules/stundenplan/freigabe";
import { hasPermission } from "@/core/permissions";
import { AutoRefresh } from "@schulos/ui/auto-refresh";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { cn } from "@schulos/ui/cn";
import { EmptyState, PageHeader } from "@schulos/ui/misc";

export const metadata: Metadata = { title: "Vertretungsplan" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });

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

/** VT-02: Marker „neu“/„geändert“ (seit dem letzten Vortags-Versand). */
function Marker({ e, since }: { e: DaySubstitution; since: string }) {
  if (!e.marker) return null;
  return (
    <Badge tone="soft" title={`${CHANGE_MARKER_LABEL[e.marker]} ${since}`}>
      {CHANGE_MARKER_LABEL[e.marker]}
    </Badge>
  );
}

/** VT-02: Tagesmitteilungen oben im Tag. */
function DayNotes({ notes }: { notes: DayNote[] }) {
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Tagesmitteilungen" className="flex flex-col gap-1.5">
      {notes.map((n) => (
        <li key={n.id} className="rounded-lg bg-accent-soft px-3 py-2 text-sm font-medium text-accent-ink">
          {n.body}
          {n.audience === "beschaeftigte" && <span className="font-normal"> · nur Beschäftigte</span>}
        </li>
      ))}
    </ul>
  );
}

function DayPlan({
  date,
  today,
  entries,
  mine,
  notes,
  since,
  materials,
}: {
  date: string;
  today: string;
  entries: DaySubstitution[];
  mine: Set<string>;
  notes: DayNote[];
  since: string;
  materials: Map<string, { id: string }>;
}) {
  const groups = [...new Set(entries.map((e) => e.groupId))].sort((a, b) => Number(mine.has(b)) - Number(mine.has(a)));
  return (
    <section aria-labelledby={`tag-${date}`} className="flex flex-col gap-3">
      <h2 id={`tag-${date}`} className="font-display text-xl font-bold">
        {date === today ? "Heute · " : ""}
        {longDay.format(fromBerlinLocal(date))}
      </h2>
      <DayNotes notes={notes} />
      {groups.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-muted">Keine Änderungen.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const rows = entries.filter((e) => e.groupId === g);
            return (
              <article key={g} aria-label={rows[0]!.groupName} className={cn("flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-4", mine.has(g) && "border-2 border-accent")}>
                <header className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{rows[0]!.groupName}</h3>
                  {mine.has(g) && <Badge tone="soft">Deine Klasse</Badge>}
                </header>
                <ul className="flex flex-col gap-2">
                  {rows.map((e) => {
                    const room = changeRoomShift(e);
                    const material = materials.get(`${e.lessonId}:${e.date}`);
                    return (
                      <li key={`${e.id}-${e.periodNr}`} className="flex gap-3">
                        <span className="w-6 shrink-0 text-right font-semibold tabular-nums">{e.periodNr}.</span>
                        <span aria-hidden className="w-1 shrink-0 self-stretch rounded-full" style={{ background: e.color }} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className={cn("font-medium [overflow-wrap:anywhere]", changeOff(e) && "text-muted line-through")}>
                            {subjectLabel(e.subjectName, e.insteadOf)} <span className="font-normal text-muted">({e.teacherCode})</span>
                          </span>
                          <span className={cn("flex flex-wrap items-center gap-x-1.5 text-sm font-semibold", changeOff(e) ? "text-muted" : "text-warn")}>
                            <span>
                              {changeLabel(e)}
                              {changeTeacher(e, true) && ` · ${changeTeacher(e, true)}`}
                              {room && room !== e.roomId && ` · Raum ${room}`}
                            </span>
                            <Marker e={e} since={since} />
                          </span>
                          {e.reason && <span className="text-sm text-muted">Grund: {reasonLabel(e.reason)}</span>}
                          {e.note && <span className="text-sm text-muted [overflow-wrap:anywhere]">{e.note}</span>}
                          {material && (
                            <Link href={`/stundenplan/material/${material.id}`} className="text-sm font-medium text-accent-ink hover:underline">
                              Material zur Stunde
                            </Link>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * VT-02: „Meine Vertretungen“ der Lehrkraft – mit internem Hinweis (nur sie und die Planung sehen ihn), Material und „Gesehen“
 * (Kenntnisnahme, F-10-10: optional, Vorgabe an).
 */
function OwnSubstitutions({ entries, ack, since, materials }: { entries: DaySubstitution[]; ack: boolean; since: string; materials: Map<string, { id: string }> }) {
  return (
    <Card aria-labelledby="meine-vertretungen" className="gap-3">
      <h2 id="meine-vertretungen" className="text-base font-semibold">
        Meine Vertretungen
      </h2>
      <ul className="flex flex-col divide-y divide-border">
        {entries.map((e) => {
          const what = `${shortDay.format(fromBerlinLocal(e.date))} ${e.periodNr}. Std ${e.groupName}`;
          const material = materials.get(`${e.lessonId}:${e.date}`);
          const room = changeRoomShift(e);
          return (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 font-medium">
                  <span>
                    {shortDay.format(fromBerlinLocal(e.date))} · {e.periodNr}. Std · {e.groupName} · {subjectLabel(e.subjectName, e.insteadOf)}
                  </span>
                  <Marker e={e} since={since} />
                </span>
                <span className="text-sm text-muted">
                  {[changeLabel(e), `für ${e.teacherCode ?? "–"}`, room && `Raum ${room}`, reasonLabel(e.reason)].filter(Boolean).join(" · ")}
                </span>
                {e.note && <span className="text-sm [overflow-wrap:anywhere]">Hinweis für Schüler:innen: {e.note}</span>}
                {e.internal?.note && (
                  <span className="text-sm [overflow-wrap:anywhere]">
                    <span className="font-semibold">Interner Hinweis:</span> {e.internal.note}
                  </span>
                )}
                {material && (
                  <Link href={`/stundenplan/material/${material.id}`} className="text-sm font-medium text-accent-ink hover:underline">
                    Material zur Stunde
                  </Link>
                )}
              </div>
              {ack &&
                (e.internal?.acknowledgedAt ? (
                  <Badge tone="success">Gesehen</Badge>
                ) : (
                  <form action={acknowledgeSubstitutionAction.bind(null, e.id)}>
                    <Button type="submit" size="sm" aria-label={`Gesehen: ${what}`}>
                      Gesehen
                    </Button>
                  </form>
                ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default async function VertretungsplanPage() {
  const { user, perms } = await requireUser();
  const db = await getDb();
  const now = new Date();
  const today = toBerlinDate(now);
  const days = planDays(today, await loadSchoolCalendar(db));
  const marker = await markerSinceDb(db, now);
  const staff = isStaffRole(user.role);
  // Q5-11: hier steht immer der veröffentlichte Stand (wie für alle); die Planung bekommt einen Hinweis auf Entwürfe
  const [entries, mine, drafts, notes, own, ack] = await Promise.all([
    substitutionsOn(db, days, { since: marker.since }),
    myGroups(user.id, user.role),
    hasPermission(perms, "stundenplan.substitute") ? draftDays(db, days) : Promise.resolve(new Set<string>()),
    // VT-02: Tagesmitteilungen – „nur Beschäftigte“ sehen nur Beschäftigte
    dayNotesOn(db, days, { staff }),
    user.role === "lehrkraft" ? ownSubstitutions(db, user.id, days, marker.since) : Promise.resolve([]),
    acknowledgeEnabled(db),
  ]);
  // VT-02: Material-Link – nur was der Betrachter sehen darf (Schüler:innen der Gruppe mit Häkchen, Vertretung, Lehrkraft)
  const materials = await materialsFor(db, perms, [...entries.filter((e) => mine.has(e.groupId)), ...own].map((e) => ({ lessonId: e.lessonId, date: e.date })));
  const anyMarker = entries.some((e) => e.marker);

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
      {own.length > 0 && <OwnSubstitutions entries={own} ack={ack} since={marker.label} materials={materials} />}
      {entries.length === 0 && notes.length === 0 && <EmptyState title="Keine Vertretungen">Für heute und den nächsten Schultag ist nichts geändert.</EmptyState>}
      {(entries.length > 0 || notes.length > 0) &&
        days.map((d) => (
          <DayPlan
            key={d}
            date={d}
            today={today}
            entries={entries.filter((e) => e.date === d)}
            mine={mine}
            notes={notes.filter((n) => n.date === d)}
            since={marker.label}
            materials={materials}
          />
        ))}
      {anyMarker && <p className="text-sm text-muted">„neu“ und „geändert“: {marker.label}.</p>}
    </main>
  );
}
