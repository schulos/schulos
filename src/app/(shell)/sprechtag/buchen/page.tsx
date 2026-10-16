import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { childrenOf } from "@/core/school/majority";
import { toBerlinDate } from "@/core/time";
import { bookOneAction, bookSuggestionAction, cancelAppointmentAction } from "@/modules/sprechtag/actions";
import {
  STATE_LABEL,
  bookingStudents,
  eventState,
  familyAppointments,
  formatEventDay,
  invitationsFor,
  listEvents,
  suggestForFamily,
  teacherBoards,
  teachersOfStudent,
} from "@/modules/sprechtag/service";
import { roomLabel, slotEnd } from "@/modules/sprechtag/slots";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { ConfirmButton } from "../forms";
import { BookForm, SuggestionForm } from "./forms";

export const metadata: Metadata = { title: "Sprechtag: Termine buchen" };

const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export default async function BuchenPage({ searchParams }: { searchParams: Promise<{ e?: string; w?: string | string[]; gebucht?: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  const sp = await searchParams;
  const today = toBerlinDate(new Date());
  const [students, informed] = await Promise.all([bookingStudents(db, perms), perms.role === "eltern" ? childrenOf(db, perms.userId, "inform") : Promise.resolve([])]);
  const header = <PageHeader eyebrow="Elternsprechtag" title="Termine buchen" />;
  if (students.length === 0 && informed.length === 0) {
    return (
      <main className="flex flex-col gap-6">
        {header}
        <EmptyState title="Hier buchen Eltern Gesprächstermine">Volljährige Schüler:innen, die die Schule als eigenständig führt, buchen selbst.</EmptyState>
      </main>
    );
  }
  const events = await listEvents(db, perms, today);
  const e = events.find((x) => x.id === sp.e) ?? events.find((x) => eventState(x, today) === "buchung") ?? events[0];
  if (!e) {
    return (
      <main className="flex flex-col gap-6">
        {header}
        <EmptyState title="Zurzeit ist kein Sprechtag geplant" />
      </main>
    );
  }
  const state = eventState(e, today);
  const open = state === "buchung";
  const actingIds = new Set(students.map((s) => s.id));
  const appts = await familyAppointments(db, perms, e.id, { informed: true });
  const invites = await invitationsFor(
    db,
    e.id,
    students.map((s) => s.id),
  );
  const perChild = await Promise.all(
    students.map(async (s) => {
      const teacherIds = await teachersOfStudent(db, s.id, e.date);
      return { student: s, boards: await teacherBoards(db, e, teacherIds) };
    }),
  );
  const wishes = list(sp.w)
    .map((w) => w.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && actingIds.has(p[1]!));
  const suggestion = open && wishes.length ? await suggestForFamily(db, perms, e, wishes.map(([teacherId, studentId]) => ({ teacherId, studentId }))) : null;
  const nameOf = new Map(students.map((s) => [s.id, s.firstName || s.name]));
  const booked = new Set(appts.map((a) => `${a.teacherId}|${a.studentId}`));

  return (
    <main className="flex flex-col gap-6">
      {header}
      {events.length > 1 && (
        <nav aria-label="Sprechtage" className="flex flex-wrap gap-2">
          {events.map((x) => (
            <Button key={x.id} asChild size="sm" variant={x.id === e.id ? "primary" : "secondary"}>
              <Link href={`/sprechtag/buchen?e=${x.id}`}>{x.title}</Link>
            </Button>
          ))}
        </nav>
      )}
      <p className="flex flex-wrap items-center gap-2 text-muted">
        <span className="font-semibold text-ink">{e.title}</span> · {formatEventDay(e.date)} · {e.startsAt}–{e.endsAt} Uhr · Gespräche à {e.slotMinutes} min{" "}
        <Badge tone={open ? "success" : "soft"}>{STATE_LABEL[state]}</Badge>
      </p>
      {sp.gebucht && (
        <p role="status" className="text-sm text-success">
          Gebucht – die Termine stehen unter „Meine Termine“.
        </p>
      )}

      <section aria-labelledby="meine" className="flex flex-col gap-3">
        <h2 id="meine" className="font-display text-xl font-bold">
          Meine Termine
        </h2>
        {appts.length === 0 ? (
          <EmptyState title="Noch keine Termine gebucht" />
        ) : (
          <ul className="rounded-card border border-border bg-surface px-4">
            {appts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                <span className="w-28 shrink-0 font-semibold tabular-nums">
                  {a.slot}–{slotEnd(a.slot, e.slotMinutes)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="font-medium">{a.teacherName}</span>
                  <span className="text-sm text-muted">
                    {a.studentName}
                    {a.roomName ? ` · ${roomLabel(a.roomName)}` : ""}
                  </span>
                </span>
                {actingIds.has(a.studentId) && state !== "vorbei" ? (
                  <ConfirmButton action={cancelAppointmentAction.bind(null, a.id)} question={`Termin bei ${a.teacherName} um ${a.slot} absagen?`} label="Absagen" ariaLabel={`Absagen: ${a.teacherName} ${a.slot}`} />
                ) : (
                  !actingIds.has(a.studentId) && <Badge tone="neutral">nur zur Information</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {open && perChild.some((c) => c.boards.length > 0) && (
        <Card aria-labelledby="hintereinander">
          <h2 id="hintereinander" className="text-base font-semibold">
            Termine hintereinander
          </h2>
          <p className="text-sm text-muted">Gewünschte Gespräche ankreuzen – SchulOS schlägt Zeiten möglichst ohne Wartezeit vor.</p>
          <form method="get" action="/sprechtag/buchen" aria-label="Vorschlag berechnen" className="flex flex-col gap-3">
            <input type="hidden" name="e" value={e.id} />
            {perChild.map(({ student, boards }) => (
              <fieldset key={student.id} className="flex flex-col gap-1">
                <legend className="text-sm font-medium">{student.name}</legend>
                {boards
                  .filter((b) => !booked.has(`${b.teacherId}|${student.id}`) && b.free.length > 0)
                  .map((b) => {
                    const value = `${b.teacherId}|${student.id}`;
                    const pre = wishes.some((w) => w.join("|") === value) || (!wishes.length && invites.some((i) => i.teacherId === b.teacherId && i.studentId === student.id));
                    return (
                      <label key={value} className="flex min-h-11 items-center gap-2">
                        <input type="checkbox" name="w" value={value} defaultChecked={pre} className="size-4 accent-[var(--accent)]" />
                        {b.name} {students.length > 1 && <span className="text-muted">({nameOf.get(student.id)})</span>}
                      </label>
                    );
                  })}
              </fieldset>
            ))}
            <div>
              <Button type="submit">Vorschlag berechnen</Button>
            </div>
          </form>
          {wishes.length > 0 &&
            (suggestion ? (
              <section aria-label="Vorschlag" className="flex flex-col gap-2 rounded-xl bg-surface-2 p-4">
                <h3 className="font-semibold">Vorschlag</h3>
                <SuggestionForm
                  action={bookSuggestionAction.bind(null, e.id)}
                  items={suggestion.map((s) => ({
                    value: `${s.teacherId}|${s.studentId}|${s.slot}`,
                    label: `${s.slot}–${slotEnd(s.slot, e.slotMinutes)} ${s.teacherName}${s.roomName ? ` (${roomLabel(s.roomName)})` : ""}${students.length > 1 ? ` – ${nameOf.get(s.studentId)}` : ""}`,
                  }))}
                />
              </section>
            ) : (
              <p role="alert" className="text-sm text-danger">
                Für diese Auswahl gibt es keine freien Zeiten mehr – bitte weniger Gespräche wählen oder einzeln buchen.
              </p>
            ))}
        </Card>
      )}

      {perChild.map(({ student, boards }) => (
        <Card key={student.id} aria-label={`Lehrkräfte von ${student.name}`}>
          <h2 className="text-base font-semibold">
            {student.name}
            {student.className && <span className="font-normal text-muted"> · {student.className}</span>}
          </h2>
          {boards.length === 0 ? (
            <p className="text-sm text-muted">Noch keine Lehrkraft dieses Kindes bietet Termine an.</p>
          ) : (
            <ul className="flex flex-col">
              {boards.map((b) => {
                const appt = appts.find((a) => a.teacherId === b.teacherId && a.studentId === student.id);
                const invited = invites.some((i) => i.teacherId === b.teacherId && i.studentId === student.id);
                return (
                  <li key={b.teacherId} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="font-medium">
                        {b.name} {invited && <Badge tone="warn">Gesprächswunsch</Badge>}
                      </span>
                      <span className="text-sm text-muted">
                        {b.roomName ? `${roomLabel(b.roomName)} · ` : ""}
                        {b.free.length} {b.free.length === 1 ? "Zeit" : "Zeiten"} frei
                      </span>
                    </span>
                    {appt ? (
                      <Badge tone="success">gebucht {appt.slot} Uhr</Badge>
                    ) : open && b.free.length > 0 ? (
                      <BookForm action={bookOneAction.bind(null, e.id, b.teacherId, student.id)} teacher={b.name} free={b.free} />
                    ) : (
                      <Badge tone="neutral">{open ? "ausgebucht" : "Buchung nicht offen"}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ))}
    </main>
  );
}
