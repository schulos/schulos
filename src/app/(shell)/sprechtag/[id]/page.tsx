import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { rooms, users, type SprechtagEvent } from "@/core/db/schema";
import { hasPermission, type PermissionSet } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import {
  cancelAppointmentAction,
  deleteEventAction,
  inviteAction,
  releaseAction,
  updateEventAction,
  withdrawAction,
  withdrawInvitationAction,
} from "@/modules/sprechtag/actions";
import { myInvitations, studentsOfTeacher } from "@/modules/sprechtag/einladung";
import {
  MANAGE,
  OFFER,
  STATE_LABEL,
  allAppointments,
  defaultRoom,
  eventState,
  formatEventDay,
  getAvailability,
  getEvent,
  teacherAppointments,
  teacherBoards,
} from "@/modules/sprechtag/service";
import { breaksText, slotEnd, slotsFor } from "@/modules/sprechtag/slots";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AvailabilityForm, ConfirmButton, EventForm, InviteForm } from "../forms";

export const metadata: Metadata = { title: "Elternsprechtag" };

export default async function SprechtagDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { perms } = await requireUser();
  const manage = hasPermission(perms, MANAGE);
  const offer = hasPermission(perms, OFFER);
  if (!manage && !offer) notFound();
  const db = await getDb();
  const e = await getEvent(db, id);
  if (!e) notFound();
  const today = toBerlinDate(new Date());
  const state = eventState(e, today);
  const slots = slotsFor(e);

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Elternsprechtag"
        title={e.title}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/sprechtag">Alle Sprechtage</Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href={`/druck/sprechtag/${e.id}`}>{manage ? "Alle Pläne drucken" : "Meinen Plan drucken"}</Link>
            </Button>
            {manage && (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/druck/sprechtag/${e.id}?art=aushang`}>Raumliste drucken</Link>
              </Button>
            )}
          </>
        }
      />
      <p className="flex flex-wrap items-center gap-2 text-muted">
        {formatEventDay(e.date)} · {e.startsAt}–{e.endsAt} Uhr · Gespräche à {e.slotMinutes} min
        {e.breaks.length > 0 && ` · Pausen ${breaksText(e.breaks)}`} <Badge tone={state === "buchung" ? "success" : "soft"}>{STATE_LABEL[state]}</Badge>
      </p>
      {offer && state !== "vorbei" && <TeacherPart perms={perms} eventId={e.id} slots={slots} slotMinutes={e.slotMinutes} date={e.date} />}
      {manage && <ManagePart perms={perms} e={e} />}
    </main>
  );
}

async function TeacherPart({ perms, eventId, slots, slotMinutes, date }: { perms: PermissionSet; eventId: string; slots: string[]; slotMinutes: number; date: string }) {
    const db = await getDb();
    const [avail, plan, roomRows, invites, students] = await Promise.all([
      getAvailability(db, eventId, perms.userId),
      teacherAppointments(db, perms, eventId, perms.userId),
      db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.active, true)).orderBy(asc(rooms.id)),
      myInvitations(db, eventId, perms.userId),
      studentsOfTeacher(db, perms.userId, date),
    ]);
    const blocked = new Set(avail?.blockedSlots ?? []);
    const roomId = avail ? (avail.roomId ?? "") : ((await defaultRoom(db, perms.userId)) ?? "");
    const bySlot = new Map(plan.map((a) => [a.slot, a]));
    return (
      <>
        <Card aria-labelledby="zeiten">
          <h2 id="zeiten" className="text-base font-semibold">
            Meine Zeiten {avail ? <Badge tone="soft">freigegeben</Badge> : <Badge tone="warn">noch nicht freigegeben</Badge>}
          </h2>
          <p className="text-sm text-muted">Haken weg = Zeit wird nicht angeboten. Eltern sehen nur „frei“ oder „belegt“.</p>
          <AvailabilityForm
            action={releaseAction.bind(null, eventId)}
            slots={slots.map((s) => ({ value: s, label: s }))}
            offered={slots.filter((s) => !blocked.has(s))}
            booked={plan.map((a) => a.slot)}
            rooms={roomRows.map((r) => ({ value: r.id, label: r.name === r.id ? r.id : `${r.id} – ${r.name}` }))}
            roomId={roomId}
            released={Boolean(avail)}
          />
          {avail && plan.length === 0 && (
            <form action={withdrawAction.bind(null, eventId)}>
              <Button type="submit" size="sm" variant="ghost">
                Nicht teilnehmen
              </Button>
            </form>
          )}
        </Card>
        <section aria-labelledby="plan" className="flex flex-col gap-3">
          <h2 id="plan" className="font-display text-xl font-bold">
            Mein Plan ({plan.length} {plan.length === 1 ? "Termin" : "Termine"})
          </h2>
          {!avail ? (
            <EmptyState title="Noch keine Zeiten freigegeben" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Schüler:in</th>
                  <th>Klasse</th>
                  <th>gebucht von</th>
                  <th>
                    <span className="sr-only">Aktion</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {slots.map((s) => {
                  const a = bySlot.get(s);
                  return (
                    <tr key={s} className={blocked.has(s) && !a ? "text-muted" : undefined}>
                      <td className="tabular-nums">
                        {s}–{slotEnd(s, slotMinutes)}
                      </td>
                      <td>{a ? a.studentName : blocked.has(s) ? "nicht angeboten" : "frei"}</td>
                      <td>{a?.className ?? ""}</td>
                      <td>{a?.bookedByName ?? ""}</td>
                      <td className="text-right">
                        {a && <ConfirmButton action={cancelAppointmentAction.bind(null, a.id)} question={`Termin mit ${a.studentName} um ${s} absagen? Die Familie bekommt eine Nachricht.`} label="Absagen" ariaLabel={`Absagen: ${a.studentName} ${s}`} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </section>
        <Card aria-labelledby="wunsch">
          <h2 id="wunsch" className="text-base font-semibold">
            Gesprächswunsch an Eltern
          </h2>
          <p className="text-sm text-muted">Die Eltern (bei volljährigen, eigenständigen Schüler:innen die Person selbst) bekommen eine Nachricht mit der Bitte, einen Termin zu buchen.</p>
          {avail ? (
            <InviteForm action={inviteAction.bind(null, eventId)} students={students.map((s) => ({ value: s.id, label: `${s.name}${s.className ? ` (${s.className})` : ""}` }))} />
          ) : (
            <p className="text-sm">Zuerst eigene Zeiten freigeben.</p>
          )}
          {invites.length > 0 && (
            <ul className="flex flex-col gap-1">
              {invites.map((i) => (
                <li key={i.studentId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{i.name}</span>
                  {i.className && <span className="text-muted">{i.className}</span>}
                  {i.bookedSlot ? <Badge tone="success">gebucht {i.bookedSlot}</Badge> : <Badge tone="warn">noch nicht gebucht</Badge>}
                  {!i.bookedSlot && (
                    <form action={withdrawInvitationAction.bind(null, eventId, i.studentId)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Gesprächswunsch zurücknehmen: ${i.name}`}>
                        Zurücknehmen
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }

async function ManagePart({ perms, e }: { perms: PermissionSet; e: SprechtagEvent }) {
    const db = await getDb();
    const eventId = e.id;
    const [boards, appts, teacherCount] = await Promise.all([
      teacherBoards(db, e),
      allAppointments(db, perms, eventId),
      db.select({ id: users.id }).from(users).where(and(eq(users.role, "lehrkraft"), eq(users.status, "active"))),
    ]);
    return (
      <>
        <section aria-labelledby="uebersicht" className="flex flex-col gap-3">
          <h2 id="uebersicht" className="font-display text-xl font-bold">
            Übersicht
          </h2>
          <p className="text-sm text-muted">
            {boards.length} von {teacherCount.length} Lehrkräften haben Zeiten freigegeben · {appts.length} {appts.length === 1 ? "Termin" : "Termine"} gebucht
          </p>
          {boards.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th>Lehrkraft</th>
                  <th>Raum</th>
                  <th>gebucht</th>
                  <th>frei</th>
                </tr>
              </thead>
              <tbody>
                {boards.map((b) => (
                  <tr key={b.teacherId}>
                    <td>
                      {b.name}
                      {b.shortCode && <span className="text-muted"> ({b.shortCode})</span>}
                    </td>
                    <td>{b.roomName ?? b.roomId ?? "–"}</td>
                    <td className="tabular-nums">{b.taken.length}</td>
                    <td className="tabular-nums">{b.free.length}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
        <Card aria-labelledby="aendern">
          <h2 id="aendern" className="text-base font-semibold">
            Sprechtag ändern
          </h2>
          <EventForm
            action={updateEventAction.bind(null, eventId)}
            submitLabel="Änderungen speichern"
            savedText="Gespeichert."
            defaults={{
              title: e.title,
              date: e.date,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
              slotMinutes: String(e.slotMinutes),
              breaks: breaksText(e.breaks),
              bookingOpensOn: e.bookingOpensOn,
              bookingClosesOn: e.bookingClosesOn,
            }}
          />
          <div>
            <ConfirmButton action={deleteEventAction.bind(null, eventId)} question="Sprechtag löschen? Alle Termine entfallen, Lehrkräfte und Familien bekommen eine Nachricht." label="Sprechtag löschen" />
          </div>
        </Card>
      </>
    );
  }
