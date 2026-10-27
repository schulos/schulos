import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auditRead } from "@/core/audit";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { saveEntryAction } from "@/modules/klassenbuch/actions";
import sitzplanModule from "@/modules/sitzplan/manifest";
import { planForLesson } from "@/modules/sitzplan/service";
import { canRead, canWrite, lessonContext, type LessonContext } from "@/modules/klassenbuch/service";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { changeLabel, changeRoomShift, changeTeacher, coupledGroupLabel, reasonLabel } from "@/modules/stundenplan/display";
import { lessonSubstitution, type DaySubstitution } from "@/modules/stundenplan/vertretung";
import { materialsFor } from "@/modules/stundenplan/selbstmeldung";
import Link from "next/link";
import { EntryForm } from "./entry-form";

export const metadata: Metadata = { title: "Klassenbuch-Eintrag" };

/**
 * VT-02: Hinweis zur Änderung der Stunde (Vertretung, Betreuung, Raum) mit Grund-Kategorie und Hinweis für Schüler:innen; den
 * internen Hinweis sehen nur die vertretende Lehrkraft und die Planung (`lessonSubstitution` lässt ihn sonst weg).
 */
function ChangeNotice({ change }: { change: DaySubstitution }) {
  const room = changeRoomShift(change);
  const who = changeTeacher(change, true);
  return (
    <Card aria-label="Änderung der Stunde" className="gap-1.5 border-warn-border bg-warn-soft">
      <p className="text-sm font-semibold">
        {[changeLabel(change), who && (change.kind === "substitute" ? `durch ${who}` : who), room && room !== change.roomId && `Raum ${room}`].filter(Boolean).join(" · ")}
      </p>
      {change.reason && <p className="text-sm">Grund: {reasonLabel(change.reason)}</p>}
      {change.note && <p className="text-sm [overflow-wrap:anywhere]">Hinweis für Schüler:innen: {change.note}</p>}
      {change.internal?.note && (
        <p className="text-sm [overflow-wrap:anywhere]">
          <span className="font-semibold">Interner Hinweis:</span> {change.internal.note}
        </p>
      )}
    </Card>
  );
}

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });

export default async function EintragPage({ searchParams }: { searchParams: Promise<{ stunde?: string; datum?: string }> }) {
  const { user, perms } = await requireUser();
  const sp = await searchParams;
  if (!sp.stunde || !/^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "")) notFound();
  const db = await getDb();
  let ctx: LessonContext;
  try {
    ctx = await lessonContext(db, sp.stunde, sp.datum!);
  } catch {
    notFound();
  }
  if (!canRead(perms, ctx)) notFound();
  const back = `/klassenbuch?datum=${ctx.date}`;
  const today = toBerlinDate(new Date());
  const title = `${ctx.periodNr}. Std · ${ctx.subjectName}`;
  const eyebrow = `${ctx.groupName} · ${longDay.format(fromBerlinLocal(ctx.date))}`;

  if (!canWrite(perms, ctx)) {
    // fremde Stunde lesen (mit Fehlzeiten) wird protokolliert; die eigene Stunde zu führen nicht
    await auditRead(db, user.id, "lesen.klassenbuch", ctx.groupId, { date: ctx.date, period: ctx.periodNr });
    const absent = ctx.students.filter((s) => ctx.absences.has(s.id));
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow={eyebrow} title={title} />
        {!ctx.entry ? (
          <EmptyState title="Noch kein Eintrag" />
        ) : (
          <Card>
            <p>
              <span className="text-sm text-muted">Thema</span>
              <br />
              {ctx.entry.topic}
            </p>
            {ctx.entry.homework && (
              <p>
                <span className="text-sm text-muted">Hausaufgabe</span>
                <br />
                {ctx.entry.homework}
                {ctx.entry.homeworkDue && <span className="text-sm text-muted"> · fällig {longDay.format(fromBerlinLocal(ctx.entry.homeworkDue))}</span>}
              </p>
            )}
            <p className="text-sm text-muted">
              {absent.length === 0
                ? "Alle anwesend."
                : `Nicht anwesend: ${absent.map((s) => (ctx.absences.get(s.id)!.kind === "late" ? `${s.name} (${ctx.absences.get(s.id)!.minutesLate} Min. verspätet)` : ctx.onLeave.has(s.id) ? `${s.name} (beurlaubt)` : s.name)).join(", ")}`}
            </p>
          </Card>
        )}
      </main>
    );
  }

  // P5-03: Sitzplan zur Stunde (Lehrkräfte der Gruppe und wer die Stunde hält) – Fehlzeit per Klick am Platz
  const seat = isEnabled(sitzplanModule, await loadModuleStates(db))
    ? await planForLesson(db, perms, { groupId: ctx.groupId, subjectId: ctx.subjectId, roomId: ctx.roomId, teacherId: ctx.teacherId }, today)
    : null;
  // Q5-12: Vertretungsmaterial der abwesenden Lehrkraft (für die Vertretung bzw. die Lehrkraft selbst)
  const material = (await materialsFor(db, perms, [{ lessonId: ctx.lessonId, date: ctx.date }])).get(`${ctx.lessonId}:${ctx.date}`);
  const change = await lessonSubstitution(db, perms, ctx.lessonId, ctx.date);
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow={eyebrow} title={title} />
      {change && <ChangeNotice change={change} />}
      {material && (
        <Card aria-label="Vertretungsmaterial" className="gap-2 border-warn-border bg-warn-soft">
          <p className="text-sm font-semibold">Vertretungsmaterial liegt vor</p>
          {material.text && <p className="whitespace-pre-line text-sm">{material.text}</p>}
          <Link href={`/stundenplan/material/${material.id}`} className="text-sm font-medium text-accent-ink hover:underline">
            {material.fileName ? `Material mit Datei „${material.fileName}“ öffnen` : "Material öffnen"}
          </Link>
        </Card>
      )}
      <EntryForm
        seatPlan={
          seat
            ? {
                title: seat.plan.title,
                href: `/sitzplan/${seat.plan.id}`,
                rows: seat.plan.rows,
                cols: seat.plan.cols,
                desks: seat.plan.desks,
                seats: seat.seats,
                students: seat.students.map((s) => ({ id: s.id, name: s.name, initials: s.initials, photo: s.photo })),
              }
            : undefined
        }
        action={saveEntryAction}
        lessonId={ctx.lessonId}
        date={ctx.date}
        initial={{ topic: ctx.entry?.topic ?? "", homework: ctx.entry?.homework ?? "", homeworkDue: ctx.entry?.homeworkDue ?? "" }}
        dueMin={addDays(ctx.date > today ? ctx.date : today, 1)}
        students={ctx.students.map((s) => {
          const a = ctx.absences.get(s.id);
          return { id: s.id, name: s.name, status: a?.kind ?? "present", minutes: a?.minutesLate ? String(a.minutesLate) : "", excused: a?.excused ?? null, onLeave: ctx.onLeave.has(s.id) };
        })}
        cancelHref={back}
        coupledLabel={ctx.coupled.length ? coupledGroupLabel(ctx.coupled.map((c) => c.groupName)) : undefined}
      />
    </main>
  );
}
