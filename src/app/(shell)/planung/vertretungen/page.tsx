import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { TZ, addDays, fromBerlinLocal, toBerlinDate } from "@/core/time";
import {
  applySuggestionAction,
  cancelReleasedAction,
  createAbsenceAction,
  deleteAbsenceAction,
  deleteSubstitutionAction,
  keepReviewedAction,
  deleteDayNoteAction,
  publishDayAction,
  sendNotificationsNowAction,
  removeReviewedAction,
  saveDayNoteAction,
  saveSubstitutionAction,
  shortenAbsenceAction,
} from "@/modules/stundenplan/actions";
import { SUBSTITUTION_REASONS } from "@/modules/stundenplan/schema";
import { dayNotesOn, DAY_NOTE_AUDIENCE_LABELS } from "@/modules/stundenplan/tagesmitteilungen";
import { DayNoteForm } from "./day-note-form";
import { markerSinceDb, NOTIFY_AUDIENCE_LABELS, plannedNotifications } from "@/modules/stundenplan/benachrichtigung";
import { dayRelease, draftDays, openDrafts } from "@/modules/stundenplan/freigabe";
import { ABSENCE_LABELS, endedAbsenceReviews, GROUP_REASONS, needsOn, TEACHER_REASONS } from "@/modules/stundenplan/abwesenheit";
import { CHANGE_KIND_LABEL, CHANGE_MARKER_LABEL, changeLabel, changeOff, changeRoomShift, changeTeacher, slotDisplay, SUBSTITUTION_REASON_LABELS, subjectLabel } from "@/modules/stundenplan/display";
import { plannableGroups, teacherOptions } from "@/modules/stundenplan/manage";
import { listSlots, timetableMasterData, type PlanTarget } from "@/modules/stundenplan/service";
import { acknowledgeEnabled, defaultReason, examSubjectsOn, mergeOptions, planDays, substitutionsOn, teacherAvailability, unacknowledgedSubstitutions } from "@/modules/stundenplan/vertretung";
import { describeChange, substitutionHistory } from "@/modules/stundenplan/vertretung-historie";
import { inArray } from "drizzle-orm";
import { users } from "@/core/db/schema";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import Link from "next/link";
import { suggestSubstitutes } from "@/modules/stundenplan/vorschlaege";
import { weekNeeds } from "@/modules/stundenplan/dauervertretung";
import { KIND_LABEL as EXAM_KIND } from "@/modules/klausurplan/service";
import { materialsFor } from "@/modules/stundenplan/selbstmeldung";
import { AbsenceForm } from "./absence-form";
import { SubstitutionForm } from "./substitution-form";

export const metadata: Metadata = { title: "Vertretungen" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const plannedAt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const stamp = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export default async function VertretungenPage({ searchParams }: { searchParams: Promise<{ datum?: string; lehrkraft?: string; gruppe?: string; fehler?: string; veroeffentlicht?: string; verkuerzt?: string; gesendet?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.substitute")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  const today = toBerlinDate(new Date());
  const shown = planDays(today, cal);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : shown[0];
  const marker = await markerSinceDb(db, new Date());
  const [teachers, groupList, master, changes, needs, release, drafts, shownChanges, shownDrafts, week, reviews, dayNotes, history, unconfirmed, ack, planned] = await Promise.all([
    teacherOptions(db),
    plannableGroups(db),
    timetableMasterData(db),
    // VT-01: mit internem Hinweis und Kenntnisnahme (nur hier, Vertretungsplanung)
    substitutionsOn(db, [date], { drafts: true, internal: true, since: marker.since }),
    needsOn(db, date),
    dayRelease(db, date),
    openDrafts(db, today),
    substitutionsOn(db, shown, { drafts: true }),
    draftDays(db, shown),
    // SP2-08 (SP-G-10): Vertretungsbedarf der nächsten fünf Schultage
    weekNeeds(db, today),
    // SP2-16b: Änderungen nach dem Ende einer verkürzten/aufgehobenen Abwesenheit – „Abwesenheit beendet – prüfen“
    endedAbsenceReviews(db, today),
    // VT-01: Tagesmitteilungen (alle Zielgruppen, auch an Entwurfstagen)
    dayNotesOn(db, [date], { drafts: true, staff: true }),
    // VT-02 (F-10-13): Verlauf je Stunde – nur Vertretungsplanung
    substitutionHistory(db, perms, date, date),
    // VT-02 (F-10-10): Vertretungen der nächsten Tage, die noch niemand bestätigt hat (nur bei eingeschalteter Kenntnisnahme)
    unacknowledgedSubstitutions(db, perms, [...new Set([...shown, date])].sort()),
    acknowledgeEnabled(db),
    // VT-04: eingeplante Vertretungsnachrichten („geplant für …“, „jetzt senden“)
    plannedNotifications(db),
  ]);
  const actorIds = [...new Set(history.map((h) => h.actorId).filter((x): x is string => !!x))];
  const actors = new Map(
    actorIds.length ? (await db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, actorIds))).map((u) => [u.id, u.code ?? u.name]) : [],
  );
  const historyOf = (lessonId: string) => history.filter((h) => h.lessonId === lessonId);
  const notified = /^\d+$/.test(sp.veroeffentlicht ?? "") ? Number(sp.veroeffentlicht) : null;
  const shortened = /^\d+$/.test(sp.verkuerzt ?? "") ? Number(sp.verkuerzt) : null;
  const sentNow = /^\d+$/.test(sp.gesendet ?? "") ? Number(sp.gesendet) : null;

  const target: PlanTarget | null = sp.lehrkraft ? { kind: "teacher", id: sp.lehrkraft } : sp.gruppe ? { kind: "group", id: sp.gruppe } : null;
  // nur eigene Stunden der Lehrkraft/Gruppe – übernommene Vertretungen werden bei der Original-Stunde gepflegt
  // SP2-07: eine verlegte Stunde wird bei ihrer bisherigen Stunde gepflegt (nicht zusätzlich in der neuen)
  const lessons = target ? (await listSlots(db, target, date, addDays(date, 1), { drafts: true })).filter((s) => s.perspective !== "covering" && s.moved !== "to") : [];
  const [availability, suggestions, examsByGroup, merges, reasonDefaults] = await Promise.all([
    Promise.all(lessons.map((l) => teacherAvailability(db, l.lessonId, date))),
    Promise.all(lessons.map((l) => (l.change && l.change.kind !== "room" ? Promise.resolve([]) : suggestSubstitutes(db, l.lessonId, date)))),
    // SP-12: Klausur-Hinweis im Formular, wenn das gewählte Fach an dem Tag eine Arbeit hat
    examSubjectsOn(db, [...new Set(lessons.map((l) => l.groupId))], date),
    Promise.all(lessons.map((l) => mergeOptions(db, l.lessonId, date))),
    // VT-01: Vorgabe der Grund-Kategorie je Stunde (Anzeige bei „automatisch“)
    Promise.all(lessons.map((l) => defaultReason(db, l, date, l.change?.kind ?? "substitute"))),
  ]);
  const reasonOptions = SUBSTITUTION_REASONS.map((r) => ({ value: r, label: SUBSTITUTION_REASON_LABELS[r] }));
  // SP2-08: mehrtägige Abwesenheit der Lehrkraft einer Stunde → Dauervertretung anbieten
  const permanentFor = (teacherId: string | null) => {
    const a = teacherId ? needs.absences.find((x) => x.teacherId === teacherId && x.endsOn > date) : undefined;
    return a ? { absenceId: a.id, until: `${a.endsOn.slice(8)}.${a.endsOn.slice(5, 7)}.` } : undefined;
  };
  const periodOptions = master.periods.map((p) => ({ nr: p.nr, label: `${p.nr}. Stunde (${p.startsAt.slice(0, 5)})` }));
  const subjectOptions = master.subjects.map((x) => ({ id: x.id, label: x.name }));
  const here = `/planung/vertretungen?datum=${date}${sp.lehrkraft ? `&lehrkraft=${sp.lehrkraft}` : ""}${sp.gruppe ? `&gruppe=${sp.gruppe}` : ""}`;
  const openCount = needs.open.filter((o) => o.status === "open").length;
  // Q5-12: „Material liegt vor“ je offener Stunde
  const materials = await materialsFor(db, perms, needs.open.map((o) => ({ lessonId: o.lessonId, date })));
  const roomOptions = master.rooms.map((r) => ({ id: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` }));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Stundenplanung"
        title="Vertretungen"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/planung/vertretungen/bereitschaft">Bereitschaften</Link>
            </Button>
            <Button asChild>
              <Link href="/planung/vertretungen/statistik">Statistik</Link>
            </Button>
          </div>
        }
      />
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      <nav aria-label="Tage im Vertretungsplan" className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Im Vertretungsplan:</span>
        {[...new Set([...shown, ...drafts])].sort().map((d) => {
          const n = shownChanges.filter((c) => c.date === d).length;
          const draft = shownDrafts.has(d) || drafts.includes(d);
          return (
            <Link
              key={d}
              href={`/planung/vertretungen?datum=${d}`}
              aria-current={d === date ? "date" : undefined}
              className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 hover:border-border-strong aria-[current=date]:border-accent"
            >
              <span className="font-medium">{shortDay.format(fromBerlinLocal(d))}</span>
              {shown.includes(d) && <span className="text-muted">{n === 0 ? "keine Änderungen" : n === 1 ? "1 Änderung" : `${n} Änderungen`}</span>}
              {draft && <Badge tone="warn">Entwurf</Badge>}
            </Link>
          );
        })}
      </nav>
      {notified !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Veröffentlicht{notified > 0 ? ` – Nachricht an ${notified === 1 ? "1 Person" : `${notified} Personen`} eingeplant (siehe „Nachrichten“).` : "."}
        </p>
      )}
      {sentNow !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          {sentNow === 0 ? "Gesendet – es gab nichts Neues zu melden." : `Gesendet – ${sentNow === 1 ? "1 Nachricht" : `${sentNow} Nachrichten`}.`}
        </p>
      )}
      {planned.length > 0 && (
        <section aria-labelledby="planned-title" className="flex flex-col gap-2">
          <h2 id="planned-title" className="text-base font-semibold">
            Nachrichten
          </h2>
          <ul aria-label="Geplante Nachrichten" className="flex flex-col gap-1.5 text-sm">
            {planned.map((p) => (
              <li key={`${p.date}-${p.audience}`} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  <span className="font-medium">{shortDay.format(fromBerlinLocal(p.date))}</span> · {NOTIFY_AUDIENCE_LABELS[p.audience]} ·{" "}
                  {p.people === 1 ? "1 Person" : `${p.people} Personen`}
                </span>
                <span className="text-muted">geplant für {plannedAt.format(p.dueAt)} Uhr</span>
                <form action={sendNotificationsNowAction.bind(null, p.date, p.audience, here)}>
                  <Button type="submit" size="sm" aria-label={`Jetzt senden: ${shortDay.format(fromBerlinLocal(p.date))}, ${NOTIFY_AUDIENCE_LABELS[p.audience]}`}>
                    jetzt senden
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
      {shortened !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Abwesenheit verkürzt
          {shortened > 0
            ? ` – ${shortened === 1 ? "1 Änderung danach bleibt stehen und ist" : `${shortened} Änderungen danach bleiben stehen und sind`} unten zur Prüfung markiert.`
            : "."}
        </p>
      )}
      {release.draft ? (
        <Card aria-label="Entwurf" className="gap-3 border-warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Entwurf – noch nicht veröffentlicht</h2>
              <p className="text-sm text-muted">
                Schüler:innen, Eltern, Lehrkräfte und die Monitore sehen die Änderungen vom {longDay.format(fromBerlinLocal(date))} erst nach dem
                Veröffentlichen. Dann bekommt jede betroffene Person eine Nachricht mit allen Änderungen des Tages – zur eingestellten Zeit am
                Vortag, für heute sofort; spätere Änderungen gelten sofort.
              </p>
            </div>
            <form action={publishDayAction.bind(null, date)}>
              <Button type="submit" variant="primary">
                Tag veröffentlichen
              </Button>
            </form>
          </div>
        </Card>
      ) : (
        release.mode === "freigabe" && (
          <p aria-label="Freigabe" className="text-sm text-muted">
            {changes.length > 0 || release.publishedAt
              ? "Dieser Tag ist veröffentlicht – weitere Änderungen gelten sofort und melden sich bei den Betroffenen."
              : "Vertretungsplan mit Freigabe: Die erste Änderung an diesem Tag legt einen Entwurf an, den du danach veröffentlichst."}
          </p>
        )
      )}
      <section aria-labelledby="day-notes-title" className="flex flex-col gap-2">
        <h2 id="day-notes-title" className="text-base font-semibold">
          Tagesmitteilungen am {longDay.format(fromBerlinLocal(date))}
        </h2>
        {dayNotes.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {dayNotes.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-2">
                <span>{n.body}</span>
                {n.audience !== "alle" && <Badge tone="neutral">{DAY_NOTE_AUDIENCE_LABELS[n.audience]}</Badge>}
                <form action={deleteDayNoteAction.bind(null, n.id)}>
                  <Button type="submit" size="sm" variant="ghost" aria-label={`Tagesmitteilung löschen: ${n.body}`}>
                    Löschen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <DayNoteForm action={saveDayNoteAction.bind(null, null)} date={date} />
      </section>
      <section aria-labelledby="week-title" className="flex flex-col gap-2">
        <h2 id="week-title" className="text-base font-semibold">
          Vertretungsbedarf der nächsten Schultage
        </h2>
        <ul aria-label="Wochenblick" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {week.map((w) => (
            <li key={w.date}>
              <Link
                href={`/planung/vertretungen?datum=${w.date}`}
                aria-current={w.date === date ? "date" : undefined}
                className="flex flex-col gap-1 rounded-xl border border-border bg-surface px-3 py-2 text-sm hover:border-border-strong aria-[current=date]:border-accent"
              >
                <span className="font-medium">{shortDay.format(fromBerlinLocal(w.date))}</span>
                {w.open > 0 ? <Badge tone="warn">{w.open} offen</Badge> : <span className="text-muted">{w.absences === 0 ? "keine Abwesenheit" : "nichts offen"}</span>}
                {w.settled > 0 && <span className="text-muted">{w.settled} geregelt</span>}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {reviews.length > 0 && (
        <Card aria-labelledby="review-title" className="gap-3 border-warn">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="review-title" className="flex flex-wrap items-center gap-2 text-base font-semibold">
                Abwesenheit beendet – prüfen
                <Badge tone="warn">{reviews.length}</Badge>
              </h2>
              <p className="text-sm text-muted">
                Die Abwesenheit wurde verkürzt oder aufgehoben. Diese Vertretungen stehen weiter im Plan – behalten oder entfernen (Betroffene werden benachrichtigt).
              </p>
            </div>
            <form action={removeReviewedAction.bind(null, date)}>
              <Button type="submit" size="sm">
                Alle entfernen
              </Button>
            </form>
          </div>
          <Table>
            <caption className="sr-only">Vertretungen nach dem Ende einer Abwesenheit</caption>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Std.</th>
                <th>Klasse</th>
                <th>Fach</th>
                <th>Art</th>
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {reviews.map((r) => {
                const what = `${shortDay.format(fromBerlinLocal(r.date))} ${r.groupName} ${r.periodNr}. Std`;
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/planung/vertretungen?datum=${r.date}`} className="font-medium hover:underline">
                        {shortDay.format(fromBerlinLocal(r.date))}
                      </Link>
                    </td>
                    <td className="tabular-nums">{r.periodNr}.</td>
                    <td className="font-medium whitespace-nowrap">{r.groupName}</td>
                    <td className="whitespace-nowrap">
                      {r.subjectName} <span className="text-muted">({r.teacherCode})</span>
                    </td>
                    <td className="whitespace-nowrap">
                      {CHANGE_KIND_LABEL[r.kind]}
                      {r.substituteCode && <span className="text-muted"> · {r.substituteCode}</span>}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <form action={keepReviewedAction.bind(null, r.id)} className="inline">
                        <Button type="submit" size="sm" variant="ghost" aria-label={`Behalten: ${what}`}>
                          Behalten
                        </Button>
                      </form>
                      <form action={deleteSubstitutionAction.bind(null, r.id)} className="inline">
                        <Button type="submit" size="sm" variant="ghost" aria-label={`Entfernen: ${what}`}>
                          Entfernen
                        </Button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
      {unconfirmed.length > 0 && (
        <Card aria-labelledby="unconfirmed-title" className="gap-3">
          <h2 id="unconfirmed-title" className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Noch nicht bestätigt
            <Badge tone="warn">{unconfirmed.length}</Badge>
          </h2>
          <p className="-mt-2 text-sm text-muted">Vertretungen an veröffentlichten Tagen, die die Vertretungslehrkraft noch nicht mit „Gesehen“ bestätigt hat.</p>
          <ul className="flex flex-col gap-1 text-sm">
            {unconfirmed.map((u) => (
              <li key={`${u.id}-${u.periodNr}`} className="flex flex-wrap gap-x-2">
                <Link href={`/planung/vertretungen?datum=${u.date}`} className="font-medium hover:underline">
                  {shortDay.format(fromBerlinLocal(u.date))}
                </Link>
                <span>
                  {u.periodNr}. Std · {u.groupName} · {subjectLabel(u.subjectName, u.insteadOf)}
                </span>
                <span className="text-muted">
                  {changeLabel(u)} durch {u.substituteCode ?? u.substituteName ?? "–"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card aria-labelledby="absence-title" className="gap-3">
        <h2 id="absence-title" className="text-base font-semibold">
          Abwesenheit eintragen
        </h2>
        <p className="-mt-2 text-sm text-muted">
          Fehlt eine Lehrkraft, werden ihre Stunden offen. Fehlt eine Klasse (Exkursion, Praktikum), entfallen ihre Stunden und die Lehrkräfte sind frei für Vertretungen.
        </p>
        <AbsenceForm
          action={createAbsenceAction}
          date={date}
          teachers={teachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.name}` }))}
          groups={groupList.map((g) => ({ value: g.id, label: g.name }))}
          periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))}
          teacherReasons={TEACHER_REASONS.map((r) => ({ value: r, label: ABSENCE_LABELS[r] }))}
          groupReasons={GROUP_REASONS.map((r) => ({ value: r, label: ABSENCE_LABELS[r] }))}
        />
      </Card>
      <form className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-[11rem_1fr_1fr_auto]" aria-label="Stunden wählen">
        <Input type="date" name="datum" defaultValue={date} aria-label="Datum" required />
        <Select name="lehrkraft" defaultValue={sp.lehrkraft ?? ""} aria-label="Lehrkraft (z. B. erkrankt)">
          <option value="">Lehrkraft (z. B. erkrankt) …</option>
          {teachers.map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} – {t.name}
            </option>
          ))}
        </Select>
        <Select name="gruppe" defaultValue={sp.gruppe ?? ""} aria-label="oder Klasse/Kurs">
          <option value="">oder Klasse/Kurs …</option>
          {(["klasse", "kurs", "ag"] as const).map((kind) => (
            <optgroup key={kind} label={GROUP_KIND_LABELS[kind]}>
              {groupList
                .filter((g) => g.kind === kind)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
        <Button type="submit">Anzeigen</Button>
      </form>

      <section aria-labelledby="needs-title" className="flex flex-col gap-3">
        <h2 id="needs-title" className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
          Vertretungsbedarf am {longDay.format(fromBerlinLocal(date))}
          {openCount > 0 && <Badge tone="warn">{openCount} offen</Badge>}
        </h2>
        {needs.absences.length === 0 ? (
          <p className="text-sm text-muted">Für diesen Tag ist keine Abwesenheit eingetragen.</p>
        ) : (
          <>
            <ul aria-label="Abwesenheiten" className="flex flex-wrap gap-2">
              {needs.absences.map((a) => (
                <li key={a.id} className="flex items-center gap-2 rounded-xl border border-border bg-surface py-1 pr-1 pl-3 text-sm">
                  <span className="font-semibold">{a.label}</span>
                  <span className="text-muted">
                    {ABSENCE_LABELS[a.reason]}
                    {a.fromPeriod !== null && ` · ${a.fromPeriod === a.toPeriod ? `${a.fromPeriod}.` : `${a.fromPeriod}.–${a.toPeriod}.`} Std.`}
                    {a.startsOn !== a.endsOn && ` · bis ${a.endsOn.slice(8)}.${a.endsOn.slice(5, 7)}.`}
                    {a.note && ` · ${a.note}`}
                    {a.selfReported && " · selbst gemeldet"}
                  </span>
                  {/* SP2-16b: früher zurück – Ende vorziehen; Vertretungen danach werden zur Prüfung markiert */}
                  {a.startsOn !== a.endsOn && (
                    <form action={shortenAbsenceAction.bind(null, a.id, date)} className="flex items-center gap-1">
                      <Input
                        type="date"
                        name="endsOn"
                        required
                        min={a.startsOn}
                        max={addDays(a.endsOn, -1)}
                        defaultValue={date < a.endsOn && date >= a.startsOn ? date : a.startsOn}
                        aria-label={`Neues Ende: Abwesenheit ${a.label}`}
                        className="h-8 w-36 px-2 text-sm"
                      />
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Abwesenheit ${a.label} verkürzen`}>
                        Verkürzen
                      </Button>
                    </form>
                  )}
                  <form action={deleteAbsenceAction.bind(null, a.id, date)}>
                    <Button type="submit" size="sm" variant="ghost" aria-label={`Abwesenheit ${a.label} aufheben`}>
                      Aufheben
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            {needs.open.length > 0 && (
              <Table>
                <caption className="sr-only">Offene Stunden abwesender Lehrkräfte</caption>
                <thead>
                  <tr>
                    <th>Std.</th>
                    <th>Klasse</th>
                    <th>Fach</th>
                    <th>Lehrkraft</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Aktion</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {needs.open.map((o) => (
                    <tr key={o.lessonId}>
                      <td className="tabular-nums">{o.periodNr}.</td>
                      <td className="font-medium">{o.groupName}</td>
                      <td>{o.subjectName}</td>
                      <td>{o.teacherCode}</td>
                      <td>
                        <Badge tone={o.status === "open" ? "warn" : "success"}>{o.status === "open" ? "offen" : CHANGE_KIND_LABEL[o.status]}</Badge>
                        {o.substituteAbsent && <span className="ml-2 text-xs text-muted">Vertretung durch {o.substituteAbsent} fällt aus</span>}
                        {materials.has(`${o.lessonId}:${date}`) && (
                          <Link href={`/stundenplan/material/${materials.get(`${o.lessonId}:${date}`)!.id}`} className="ml-2 text-xs font-medium text-accent-ink hover:underline">
                            Material liegt vor
                          </Link>
                        )}
                      </td>
                      <td className="text-right">
                        <Button asChild size="sm">
                          <a href={`/planung/vertretungen?datum=${date}&lehrkraft=${o.teacherId}#lessons-title`}>{o.status === "open" ? "Vertretung eintragen" : "Ändern"}</a>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {needs.released.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Freisetzungen (Klasse abwesend, Lehrkraft frei)</h3>
                  {needs.released.some((r) => !r.cancelled) && (
                    <form action={cancelReleasedAction.bind(null, date)}>
                      <Button type="submit" size="sm">
                        Entfall für alle eintragen
                      </Button>
                    </form>
                  )}
                </div>
                <Table>
                  <caption className="sr-only">Freisetzungen</caption>
                  <thead>
                    <tr>
                      <th>Std.</th>
                      <th>Klasse</th>
                      <th>Fach</th>
                      <th>frei</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needs.released.map((r) => (
                      <tr key={r.lessonId}>
                        <td className="tabular-nums">{r.periodNr}.</td>
                        <td className="font-medium">{r.groupName}</td>
                        <td>{r.subjectName}</td>
                        <td>{r.teacherCode ?? "–"}</td>
                        <td>
                          <Badge tone={r.cancelled ? "neutral" : "warn"}>{r.cancelled ? "Entfall eingetragen" : "Entfall fehlt"}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </>
        )}
      </section>

      {target && (
        <section aria-labelledby="lessons-title" className="flex flex-col gap-3">
          <h2 id="lessons-title" className="font-display text-xl font-bold">
            Stunden am {longDay.format(fromBerlinLocal(date))}
          </h2>
          {lessons.length === 0 ? (
            <EmptyState title="An diesem Tag keine Stunden" />
          ) : (
            lessons.map((l, i) => {
              const d = slotDisplay(l, target.kind === "teacher" ? "teacher" : "group");
              const existing = changes.find((c) => c.lessonId === l.lessonId);
              // SP-12: Kopf und Feldnamen mit dem regulären Fach; bei Fachtausch steht das neue daneben
              const regularSubject = l.change?.insteadOf ?? l.subjectName;
              const regularSubjectId = l.change?.insteadOfId ?? l.subjectId;
              const label = `${l.periodNr}. Std · ${regularSubject} · ${l.groupName}`;
              return (
                <Card key={l.lessonId} className="gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="h-9 w-1.5 rounded-full" style={{ background: l.color }} />
                      <span className="flex flex-col leading-tight">
                        <span className="font-semibold">
                          {l.periodNr}. Std · {regularSubject}
                          {l.change?.subjectName && <span className="font-normal text-warn"> → {l.change.subjectName}</span>}
                        </span>
                        <span className="text-sm text-muted">{[l.groupName, l.teacherCode, l.roomId && `R ${l.roomId}`].filter(Boolean).join(" · ")}</span>
                      </span>
                    </div>
                    {d.tag && <Badge tone={d.tone === "sub" ? "warn" : "neutral"}>{d.tag}</Badge>}
                  </div>
                  {suggestions[i]!.length > 0 && (
                    <div aria-label={`Vorschläge: ${label}`} role="group" className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3">
                      <span className="text-xs font-semibold tracking-wide text-muted uppercase">Vorschläge</span>
                      <ol className="flex flex-col gap-1.5">
                        {suggestions[i]!.slice(0, 3).map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                            <form action={applySuggestionAction.bind(null, l.lessonId, date, c.id, here, null)}>
                              <Button type="submit" size="sm" aria-label={`${c.code ?? c.name} übernehmen: ${label}`}>
                                {c.code ?? c.name} übernehmen
                              </Button>
                            </form>
                            {c.suggestedSubject && (
                              <form action={applySuggestionAction.bind(null, l.lessonId, date, c.id, here, c.suggestedSubject.id)}>
                                <Button type="submit" size="sm" aria-label={`${c.code ?? c.name} mit ${c.suggestedSubject.name} übernehmen: ${label}`} title="Lehrkraft und Fach übernehmen">
                                  → {c.suggestedSubject.name}
                                </Button>
                              </form>
                            )}
                            {c.standby && <Badge tone="soft">Bereitschaft</Badge>}
                            <Badge tone={c.score > 0 ? "success" : "neutral"}>{c.score > 0 ? `+${c.score}` : c.score} Punkte</Badge>
                            <span className="text-muted">{c.reasons.map((r) => `${r.label} (${r.points > 0 ? "+" : ""}${r.points})`).join(" · ")}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <SubstitutionForm
                    action={saveSubstitutionAction}
                    removeAction={existing ? deleteSubstitutionAction.bind(null, existing.id) : undefined}
                    lessonId={l.lessonId}
                    date={date}
                    label={label}
                    initial={{
                      kind: existing?.kind ?? "substitute",
                      substituteId: l.change?.substituteId ?? "",
                      roomId: l.change?.roomId ?? "",
                      note: l.change?.note ?? "",
                      subjectId: l.change?.subjectId ?? regularSubjectId,
                      targetPeriod: l.change?.targetPeriod ? String(l.change.targetPeriod) : "",
                      mergeLessonId: l.change?.mergeLessonId ?? "",
                      reason: existing?.reason ?? "",
                      internalNote: existing?.internal?.note ?? "",
                      supervisionOnly: existing?.supervisionOnly ? "1" : "",
                    }}
                    reasons={reasonOptions}
                    defaultReasonLabel={reasonDefaults[i] ? SUBSTITUTION_REASON_LABELS[reasonDefaults[i]!] : null}
                    periods={periodOptions}
                    ownPeriod={l.periodNr}
                    mergeOptions={merges[i]!}
                    permanent={permanentFor(l.teacherId)}
                    regularSubjectId={regularSubjectId}
                    subjects={subjectOptions}
                    exams={(examsByGroup.get(l.groupId) ?? []).map((e) => ({ subjectId: e.subjectId, label: `${EXAM_KIND[e.kind]} in ${e.subjectName}` }))}
                    teachers={availability[i]!.map((t) => ({ id: t.id, label: `${t.code} – ${t.name}`, free: t.free }))}
                    rooms={roomOptions}
                  />
                </Card>
              );
            })
          )}
        </section>
      )}

      <section aria-labelledby="day-title" className="flex flex-col gap-3">
        <h2 id="day-title" className="font-display text-xl font-bold">
          Alle Änderungen am {longDay.format(fromBerlinLocal(date))}
        </h2>
        {changes.length === 0 ? (
          <EmptyState title="Noch keine Änderungen">Wähle oben eine Lehrkraft oder Klasse, um Vertretungen einzutragen.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Klasse</th>
                <th>Std.</th>
                <th>Fach</th>
                <th>Art</th>
                <th>Vertretung · Raum</th>
                <th>Hinweis</th>
                {ack && <th>Gesehen</th>}
                <th>
                  <span className="sr-only">Aktion</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={`${c.id}-${c.periodNr}`}>
                  <td className="font-medium whitespace-nowrap">{c.groupName}</td>
                  <td className="tabular-nums">{c.periodNr}.</td>
                  <td className="whitespace-nowrap">
                    {subjectLabel(c.subjectName, c.insteadOf)} <span className="text-muted">({c.teacherCode})</span>
                  </td>
                  <td>
                    <Badge tone={changeOff(c) ? "neutral" : "warn"}>{changeLabel(c)}</Badge>
                    {c.marker && (
                      <Badge tone="soft" className="ml-1" title={`${CHANGE_MARKER_LABEL[c.marker]} ${marker.label}`}>
                        {CHANGE_MARKER_LABEL[c.marker]}
                      </Badge>
                    )}
                    {c.absenceEnded && (
                      <Badge tone="danger" className="ml-1">
                        Abwesenheit beendet – prüfen
                      </Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{[changeTeacher(c), changeRoomShift(c) && changeRoomShift(c) !== c.roomId && `R ${changeRoomShift(c)}`].filter(Boolean).join(" · ") || "–"}</td>
                  <td className="text-muted">
                    {[c.reason && SUBSTITUTION_REASON_LABELS[c.reason], c.supervisionOnly && "nur Betreuung", c.note].filter(Boolean).join(" · ")}
                    {c.internal?.note && <span className="block text-xs">intern: {c.internal.note}</span>}
                    {c.movedFrom === null && historyOf(c.lessonId).length > 0 && (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer font-medium text-ink">Verlauf ({historyOf(c.lessonId).length})</summary>
                        <ol aria-label={`Verlauf: ${c.groupName} ${c.periodNr}. Std`} className="mt-1 flex flex-col gap-0.5">
                          {historyOf(c.lessonId).map((h) => (
                            <li key={h.id}>
                              {stamp.format(h.createdAt)} · {describeChange(h)}
                              {h.actorId && ` · ${actors.get(h.actorId) ?? "–"}`}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </td>
                  {ack && (
                    <td className="whitespace-nowrap">
                      {c.kind === "substitute" && !c.draft ? (
                        c.internal?.acknowledgedAt ? (
                          <Badge tone="success">gesehen</Badge>
                        ) : (
                          <Badge tone="warn">offen</Badge>
                        )
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                  )}
                  <td className="text-right">
                    <form action={deleteSubstitutionAction.bind(null, c.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`Aufheben: ${c.groupName} ${c.periodNr}. Std`}>
                        Aufheben
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
