import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, isoWeek, mondayOf, toBerlinDate } from "@/core/time";
import { createExamAction, deleteExamAction } from "@/modules/klausurplan/actions";
import { KIND_LABEL, listExams, plannableExamGroups } from "@/modules/klausurplan/service";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { planDays } from "@/modules/stundenplan/vertretung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { ExamForm } from "./exam-form";

export const metadata: Metadata = { title: "Klausurplan" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const shortDate = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: TZ });
const WEEKS = 8;

export default async function KlausurplanPage() {
  const { user, perms } = await requireUser();
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  const today = toBerlinDate(new Date());
  const [groups, master, list] = await Promise.all([plannableExamGroups(db, perms), timetableMasterData(db), listExams(db, perms, today, addDays(today, WEEKS * 7))]);
  const manage = hasPermission(perms, "klausurplan.manage");
  const weeks = [...new Set(list.map((e) => mondayOf(e.date)))];

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Organisation" title="Klausurplan" />
      {groups.length > 0 && (
        <Card aria-labelledby="neu">
          <h2 id="neu" className="text-base font-semibold">
            Arbeit eintragen
          </h2>
          <ExamForm
            action={createExamAction}
            groups={groups.map((g) => ({ value: g.id, label: g.name, subjectId: g.subjectId, course: g.kind === "kurs" }))}
            subjects={master.subjects.map((s) => ({ value: s.id, label: s.name }))}
            periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. (${p.startsAt})` }))}
            canOverride={manage}
            defaultDate={planDays(addDays(today, 7), cal)[0]}
          />
        </Card>
      )}
      <section aria-labelledby="kommend" className="flex flex-col gap-4">
        <h2 id="kommend" className="font-display text-xl font-bold">
          Die nächsten {WEEKS} Wochen
        </h2>
        {list.length === 0 ? (
          <EmptyState title="Keine Arbeiten geplant" />
        ) : (
          weeks.map((monday) => (
            <section key={monday} aria-label={`KW ${isoWeek(monday)}`} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-muted">
                KW {isoWeek(monday)} · {shortDate.format(fromBerlinLocal(monday))} – {shortDate.format(fromBerlinLocal(addDays(monday, 4)))}
              </h3>
              <ul className="rounded-card border border-border bg-surface px-4">
                {list
                  .filter((e) => mondayOf(e.date) === monday)
                  .map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                      <span className="w-20 shrink-0 text-sm font-semibold tabular-nums">{dayFmt.format(fromBerlinLocal(e.date))}</span>
                      <span aria-hidden className="h-9 w-1 shrink-0 rounded-full" style={{ background: e.color }} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="font-medium">
                          {e.subjectName} · {e.groupName}
                        </span>
                        <span className="text-sm text-muted">
                          {e.title} · {e.periodFrom === e.periodTo ? `${e.periodFrom}. Std` : `${e.periodFrom}.–${e.periodTo}. Std`} ({e.startsAt}–{e.endsAt})
                          {e.teacherCode && ` · ${e.teacherCode}`}
                        </span>
                      </span>
                      <Badge tone={e.kind === "test" ? "neutral" : "danger"}>{KIND_LABEL[e.kind]}</Badge>
                      <Link href={`/stundenplan?woche=${e.date}`} className="text-sm font-medium text-accent-ink hover:underline">
                        Im Stundenplan
                      </Link>
                      {(e.teacherId === user.id || manage) && (
                        <form action={deleteExamAction.bind(null, e.id)}>
                          <Button type="submit" size="sm" variant="ghost" aria-label={`Löschen: ${e.subjectName} ${e.groupName} ${e.date}`}>
                            Löschen
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </main>
  );
}
