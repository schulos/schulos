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
import { classDay, gongSummary, lessonGroup, needUrgency, openNeighbours, removedSubstitutions, stepSchoolDay, teacherDayContext, URGENCY } from "@/modules/stundenplan/arbeitsplatz";
import { inArray } from "drizzle-orm";
import { users } from "@/core/db/schema";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import Link from "next/link";
import type { ComponentProps } from "react";
import { suggestSubstitutes } from "@/modules/stundenplan/vorschlaege";
import { weekNeeds } from "@/modules/stundenplan/dauervertretung";
import { KIND_LABEL as EXAM_KIND } from "@/modules/klausurplan/service";
import { materialsFor } from "@/modules/stundenplan/selbstmeldung";
import { AbsenceForm } from "./absence-form";
import { ContextColumn } from "./kontext";
import { SubstitutionForm } from "./substitution-form";
import { ArbeitsplatzTasten } from "./arbeitsplatz-tasten";
import { MaterialPanel } from "./material-panel";
import { MaterialForm } from "../../stundenplan/abwesenheit/forms";
import { saveMaterialAction } from "@/modules/stundenplan/selbstmeldung-actions";

export const metadata: Metadata = { title: "Vertretungen" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const shortDay = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: TZ });
const plannedAt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const stamp = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ });

type Search = {
  datum?: string;
  lehrkraft?: string;
  gruppe?: string;
  /** VT-03a: gewählte Stunde (lessonId) – Deeplink, Zurück-Taste */
  stunde?: string;
  /** VT-03a: markierte (vorgeschlagene) Lehrkraft für den Kontext */
  vorschlag?: string;
  fehler?: string;
  veroeffentlicht?: string;
  verkuerzt?: string;
  gesendet?: string;
  /** VT-03b: „1“ = die vorige Stunde ist gespeichert, diese ist die nächste offene */
  gespeichert?: string;
};

/** Adresse des Arbeitsplatzes; leere Werte entfallen. `#lessons-title` springt mobil zur gewählten Stunde. */
function workplaceHref(p: Partial<Record<"datum" | "lehrkraft" | "gruppe" | "stunde" | "vorschlag" | "gespeichert", string | null | undefined>>, hash = ""): string {
  const q = new URLSearchParams();
  for (const k of ["datum", "lehrkraft", "gruppe", "stunde", "vorschlag", "gespeichert"] as const) if (p[k]) q.set(k, p[k]!);
  return `/planung/vertretungen?${q.toString()}${hash}`;
}

/** VT-03b: Material zur Stunde – mit der Abwesenheit der Lehrkraft, sonst ohne Abwesenheit (F-10-12); eigenes Formular wegen der Datei. */
function MaterialSection({
  label,
  material,
  action,
}: {
  label: string;
  material: { text: string | null; fileName: string | null; forStudents: boolean } | null;
  action: ComponentProps<typeof MaterialForm>["action"];
}) {
  return (
    <MaterialPanel title={`Material für die Vertretung${material ? " (liegt vor)" : ""}`} initialOpen={material !== null}>
      <p className="text-xs text-muted">Arbeitsauftrag oder Datei für die Vertretungslehrkraft – auch ohne eingetragene Abwesenheit.</p>
      <MaterialForm action={action} label={label} initial={{ text: material?.text ?? "", fileName: material?.fileName ?? null, forStudents: material?.forStudents ?? false }} />
    </MaterialPanel>
  );
}

export default async function VertretungenPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.substitute")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  const now = new Date();
  const today = toBerlinDate(now);
  const shown = planDays(today, cal);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : shown[0];
  const marker = await markerSinceDb(db, now);
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
  // VT-03a: aufgehobene Vertretungen des Tages – die Zeile fehlt in „Alle Änderungen“, der Verlauf bleibt über die Stunde erreichbar
  const removed = await removedSubstitutions(db, history, new Set(changes.map((c) => c.lessonId)));
  const actorIds = [...new Set([...history.map((h) => h.actorId), ...removed.map((r) => r.actorId)].filter((x): x is string => !!x))];
  const actors = new Map(
    actorIds.length ? (await db.select({ id: users.id, code: users.shortCode, name: users.name }).from(users).where(inArray(users.id, actorIds))).map((u) => [u.id, u.code ?? u.name]) : [],
  );
  const historyOf = (lessonId: string) => history.filter((h) => h.lessonId === lessonId);
  const notified = /^\d+$/.test(sp.veroeffentlicht ?? "") ? Number(sp.veroeffentlicht) : null;
  const shortened = /^\d+$/.test(sp.verkuerzt ?? "") ? Number(sp.verkuerzt) : null;
  const sentNow = /^\d+$/.test(sp.gesendet ?? "") ? Number(sp.gesendet) : null;

  // VT-03a: gewählte Stunde – ohne Lehrkraft/Gruppe im Link gilt die Gruppe der Stunde
  const stunde = sp.stunde || null;
  let target: PlanTarget | null = sp.lehrkraft ? { kind: "teacher", id: sp.lehrkraft } : sp.gruppe ? { kind: "group", id: sp.gruppe } : null;
  if (stunde && !target) {
    const g = await lessonGroup(db, stunde);
    if (g) target = { kind: "group", id: g };
  }
  // nur eigene Stunden der Lehrkraft/Gruppe – übernommene Vertretungen werden bei der Original-Stunde gepflegt
  // SP2-07: eine verlegte Stunde wird bei ihrer bisherigen Stunde gepflegt (nicht zusätzlich in der neuen)
  const slotsOf = async (t: PlanTarget) => (await listSlots(db, t, date, addDays(date, 1), { drafts: true })).filter((s) => s.perspective !== "covering" && s.moved !== "to");
  let targetLessons = target ? await slotsOf(target) : [];
  let chosen = stunde ? targetLessons.find((l) => l.lessonId === stunde) : undefined;
  if (stunde && !chosen && target?.kind === "teacher") {
    // Stunde gehört nicht (mehr) zur Lehrkraft – über die Gruppe öffnen
    const g = await lessonGroup(db, stunde);
    if (g) {
      target = { kind: "group", id: g };
      targetLessons = await slotsOf(target);
      chosen = targetLessons.find((l) => l.lessonId === stunde);
    }
  }
  const lessons = chosen ? [chosen] : targetLessons;
  const [availability, suggestions, examsByGroup, merges, reasonDefaults] = await Promise.all([
    Promise.all(lessons.map((l) => teacherAvailability(db, l.lessonId, date))),
    Promise.all(lessons.map((l) => (l.change && l.change.kind !== "room" ? Promise.resolve([]) : suggestSubstitutes(db, l.lessonId, date)))),
    // SP-12: Klausur-Hinweis im Formular, wenn das gewählte Fach an dem Tag eine Arbeit hat
    examSubjectsOn(db, [...new Set(lessons.map((l) => l.groupId))], date),
    Promise.all(lessons.map((l) => mergeOptions(db, l.lessonId, date))),
    // VT-01: Vorgabe der Grund-Kategorie je Stunde (Anzeige bei „automatisch“)
    Promise.all(lessons.map((l) => defaultReason(db, l, date, l.change?.kind ?? "substitute"))),
  ]);
  const targetParams = { datum: date, lehrkraft: target?.kind === "teacher" ? target.id : null, gruppe: target?.kind === "group" ? target.id : null };
  const lessonHref = (lessonId: string, extra: { vorschlag?: string } = {}) => workplaceHref({ ...targetParams, stunde: lessonId, ...extra }, "#lessons-title");
  // VT-03a: Kontext – markiert ist die gewählte Lehrkraft (`vorschlag`), sonst die eingetragene Vertretung, sonst der beste Vorschlag
  const chosenSuggestions = chosen ? suggestions[0]! : [];
  const markedId = chosen ? sp.vorschlag || chosen.change?.substituteId || chosenSuggestions[0]?.id || null : null;
  const [classPlan, teacherCtx] = chosen
    ? await Promise.all([classDay(db, chosen.groupId, date), markedId ? teacherDayContext(db, markedId, date, chosen.periodNr, master.periods) : Promise.resolve(null)])
    : [[], null];
  const markOptions = chosen
    ? [
        ...(chosen.change?.substituteId && !chosenSuggestions.slice(0, 3).some((c) => c.id === chosen!.change!.substituteId)
          ? [{ id: chosen.change.substituteId, code: chosen.change.substituteCode, name: chosen.change.substituteName ?? "" }]
          : []),
        ...chosenSuggestions.slice(0, 3),
        ...(teacherCtx && !chosenSuggestions.slice(0, 3).some((c) => c.id === teacherCtx.id) && teacherCtx.id !== chosen.change?.substituteId ? [{ id: teacherCtx.id, code: teacherCtx.code, name: teacherCtx.name }] : []),
      ].map((c) => ({ id: c.id, code: c.code, name: c.name, href: lessonHref(chosen!.lessonId, { vorschlag: c.id }).replace("#lessons-title", "#context-title") }))
    : [];

  const reasonOptions = SUBSTITUTION_REASONS.map((r) => ({ value: r, label: SUBSTITUTION_REASON_LABELS[r] }));
  // SP2-08: mehrtägige Abwesenheit der Lehrkraft einer Stunde → Dauervertretung anbieten
  const permanentFor = (teacherId: string | null) => {
    const a = teacherId ? needs.absences.find((x) => x.teacherId === teacherId && x.endsOn > date) : undefined;
    return a ? { absenceId: a.id, until: `${a.endsOn.slice(8)}.${a.endsOn.slice(5, 7)}.` } : undefined;
  };
  const periodOptions = master.periods.map((p) => ({ nr: p.nr, label: `${p.nr}. Stunde (${p.startsAt.slice(0, 5)})` }));
  const subjectOptions = master.subjects.map((x) => ({ id: x.id, label: x.name }));
  const here = workplaceHref({ ...targetParams, stunde: chosen?.lessonId });
  // VT-03a: Ampel – dringend (rot) zuerst, dann heute/noch Zeit (gelb), geregelt (grün), vorbei
  const periodOf = new Map(master.periods.map((p) => [p.nr, p]));
  const openRows = needs.open
    .map((o) => {
      const p = periodOf.get(o.periodNr);
      const urgency = p ? needUrgency({ date, startsAt: p.startsAt, endsAt: p.endsAt, open: o.status === "open" }, now) : o.status === "open" ? "heute" : "geregelt";
      return { ...o, urgency };
    })
    .sort((a, b) => URGENCY[a.urgency].order - URGENCY[b.urgency].order || a.periodNr - b.periodNr || a.groupName.localeCompare(b.groupName, "de", { numeric: true }));
  const openCount = needs.open.filter((o) => o.status === "open").length;
  const urgentCount = openRows.filter((o) => o.urgency === "dringend").length;
  // Q5-12: „Material liegt vor“ je offener Stunde
  // VT-03b: dazu das Material der gewählten Stunde (auch ohne Abwesenheit)
  const materials = await materialsFor(db, perms, [...needs.open.map((o) => ({ lessonId: o.lessonId, date })), ...(chosen ? [{ lessonId: chosen.lessonId, date }] : [])]);
  // VT-03b: ↑/↓ und „nach dem Speichern“ laufen über die offenen Stunden in der Reihenfolge der Ampel
  const openList = openRows.filter((o) => o.status === "open");
  const openById = new Map(openList.map((o) => [o.lessonId, o]));
  const openHref = (id: string | null, saved = false) => {
    const o = id ? openById.get(id) : undefined;
    return o ? workplaceHref({ datum: date, lehrkraft: o.teacherId, stunde: o.lessonId, gespeichert: saved ? "1" : null }, "#lessons-title") : null;
  };
  const nb = openNeighbours(
    openList.map((o) => o.lessonId),
    chosen?.lessonId ?? null,
  );
  const closeHref = chosen ? workplaceHref({ datum: date }, "#needs-title") : null;
  const afterSaveHref = openHref(nb.afterSave, true);
  const stayHref = workplaceHref({ ...targetParams, stunde: chosen?.lessonId, gespeichert: "1" }, "#lessons-title");
  const roomOptions = master.rooms.map((r) => ({ id: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` }));
  const gong = gongSummary(planned, now);
  const prevDay = stepSchoolDay(cal, date, -1);
  const nextDay = stepSchoolDay(cal, date, 1);
  const releaseLabel = release.draft ? "Entwurf" : release.mode === "freigabe" ? (changes.length > 0 || release.publishedAt ? "veröffentlicht" : "ohne Änderungen") : "gilt sofort";

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
      {shortened !== null && (
        <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
          Abwesenheit verkürzt
          {shortened > 0
            ? ` – ${shortened === 1 ? "1 Änderung danach bleibt stehen und ist" : `${shortened} Änderungen danach bleiben stehen und sind`} unten zur Prüfung markiert.`
            : "."}
        </p>
      )}

      {/* VT-03a: Kopfleiste – Tag, Tagwechsel, Freigabe, Zähler, Nachrichten, Unbestätigte, Tagesmitteilungen */}
      <section aria-labelledby="day-head-title" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Tagwechsel" className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link href={workplaceHref({ datum: prevDay })} aria-label={`Vortag: ${longDay.format(fromBerlinLocal(prevDay))}`}>
                <span aria-hidden>‹</span> Vortag
              </Link>
            </Button>
            <h2 id="day-head-title" className="font-display text-xl font-bold">
              {longDay.format(fromBerlinLocal(date))}
            </h2>
            <Button asChild size="sm" variant="ghost">
              <Link href={workplaceHref({ datum: nextDay })} aria-label={`Nächster Tag: ${longDay.format(fromBerlinLocal(nextDay))}`}>
                Nächster Tag <span aria-hidden>›</span>
              </Link>
            </Button>
            {date !== shown[0] && (
              <Button asChild size="sm" variant="ghost">
                <Link href="/planung/vertretungen">Heute</Link>
              </Button>
            )}
          </nav>
          <ul aria-label="Tagesstand" className="flex flex-wrap gap-2 text-sm">
            <li>
              <Badge tone={release.draft ? "warn" : "neutral"}>Freigabe: {releaseLabel}</Badge>
            </li>
            <li>
              <a href="#needs-title" className="hover:underline">
                <Badge tone="neutral">{needs.absences.length === 1 ? "1 Abwesenheit" : `${needs.absences.length} Abwesenheiten`}</Badge>
              </a>
            </li>
            <li>
              <a href="#needs-title" className="hover:underline">
                <Badge tone={urgentCount > 0 ? "danger" : openCount > 0 ? "warn" : "success"}>
                  {openCount} offen{urgentCount > 0 ? ` · ${urgentCount} dringend` : ""}
                </Badge>
              </a>
            </li>
            {ack && (
              <li>
                <a href="#unconfirmed-title" className="hover:underline">
                  <Badge tone={unconfirmed.length > 0 ? "warn" : "neutral"}>{unconfirmed.length} unbestätigt</Badge>
                </a>
              </li>
            )}
            {gong && (
              <li>
                <a href="#planned-title" className="hover:underline">
                  <Badge tone="soft">{gong}</Badge>
                </a>
              </li>
            )}
            <li>
              <a href="#day-notes-title" className="hover:underline">
                <Badge tone="neutral">{dayNotes.length === 1 ? "1 Tagesmitteilung" : `${dayNotes.length} Tagesmitteilungen`}</Badge>
              </a>
            </li>
          </ul>
        </div>
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
        {release.draft ? (
          <Card aria-label="Entwurf" className="gap-3 border-warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold">Entwurf – noch nicht veröffentlicht</h3>
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {planned.length > 0 && (
            <section aria-labelledby="planned-title" className="flex min-w-0 flex-col gap-2">
              <h3 id="planned-title" className="flex flex-wrap items-center gap-2 font-semibold">
                Nachrichten
                {gong && <Badge tone="soft">{gong}</Badge>}
              </h3>
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
          {unconfirmed.length > 0 && (
            <Card aria-labelledby="unconfirmed-title" className="min-w-0 gap-2 border-0 p-0">
              <h3 id="unconfirmed-title" className="flex flex-wrap items-center gap-2 font-semibold">
                Noch nicht bestätigt
                <Badge tone="warn">{unconfirmed.length}</Badge>
              </h3>
              <p className="text-sm text-muted">Vertretungen an veröffentlichten Tagen, die die Vertretungslehrkraft noch nicht mit „Gesehen“ bestätigt hat.</p>
              <ul className="flex flex-col gap-1 text-sm">
                {unconfirmed.map((u) => (
                  <li key={`${u.id}-${u.periodNr}`} className="flex flex-wrap gap-x-2">
                    <Link href={workplaceHref({ datum: u.date, stunde: u.lessonId }, "#lessons-title")} className="font-medium hover:underline">
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
          <section aria-labelledby="day-notes-title" className="flex min-w-0 flex-col gap-2">
            <h3 id="day-notes-title" className="font-semibold">
              Tagesmitteilungen am {longDay.format(fromBerlinLocal(date))}
            </h3>
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
        </div>
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

      {/* VT-03a: dreiteilig – offene Stunden · gewählte Stunde · Kontext; schmal untereinander */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-4">
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
                    <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface py-1 pr-1 pl-3 text-sm">
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
                {openRows.length > 0 && (
                  <Table className="[&_td]:px-2! [&_th]:px-2!">
                    <caption className="sr-only">Offene Stunden abwesender Lehrkräfte</caption>
                    <thead>
                      <tr>
                        <th>Std.</th>
                        <th>Klasse</th>
                        <th>Fach</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Aktion</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {openRows.map((o) => (
                        <tr key={o.lessonId} aria-current={o.lessonId === chosen?.lessonId ? "true" : undefined} className="aria-[current=true]:bg-accent-soft">
                          <td className="tabular-nums">{o.periodNr}.</td>
                          <td className="font-medium whitespace-nowrap">{o.groupName}</td>
                          <td>
                            {o.subjectName} <span className="block text-xs text-muted">{o.teacherCode}</span>
                          </td>
                          <td>
                            <span className="flex flex-wrap items-center gap-1">
                              <Badge tone={o.status === "open" ? "warn" : "success"}>{o.status === "open" ? "offen" : CHANGE_KIND_LABEL[o.status]}</Badge>
                              {o.status === "open" && (
                                <Badge tone={URGENCY[o.urgency].tone} title="Dringlichkeit">
                                  <span aria-hidden>●</span> {URGENCY[o.urgency].label}
                                </Badge>
                              )}
                            </span>
                            {o.substituteAbsent && <span className="block text-xs text-muted">Vertretung durch {o.substituteAbsent} fällt aus</span>}
                            {materials.has(`${o.lessonId}:${date}`) && (
                              <Link href={`/stundenplan/material/${materials.get(`${o.lessonId}:${date}`)!.id}`} className="block text-xs font-medium text-accent-ink hover:underline">
                                Material liegt vor
                              </Link>
                            )}
                          </td>
                          <td className="text-right">
                            <Button asChild size="sm" variant={o.lessonId === chosen?.lessonId ? "primary" : undefined} className="h-auto py-1 text-center whitespace-normal">
                              <Link href={workplaceHref({ datum: date, lehrkraft: o.teacherId, stunde: o.lessonId }, "#lessons-title")}>{o.status === "open" ? "Vertretung eintragen" : "Ändern"}</Link>
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
          <form className="grid gap-3 rounded-card border border-border bg-surface p-4 sm:grid-cols-2" aria-label="Stunden wählen">
            <Input type="date" name="datum" defaultValue={date} aria-label="Datum" required className="sm:col-span-2" />
            <Select name="lehrkraft" defaultValue={target?.kind === "teacher" ? target.id : ""} aria-label="Lehrkraft (z. B. erkrankt)">
              <option value="">Lehrkraft (z. B. erkrankt) …</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} – {t.name}
                </option>
              ))}
            </Select>
            <Select name="gruppe" defaultValue={target?.kind === "group" ? target.id : ""} aria-label="oder Klasse/Kurs">
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
            <Button type="submit" className="sm:col-span-2">
              Anzeigen
            </Button>
          </form>
          <Card aria-labelledby="absence-title" className="@container gap-3">
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
        </div>

        <section aria-labelledby="lessons-title" className="flex min-w-0 scroll-mt-4 flex-col gap-3">
          <h2 id="lessons-title" className="font-display text-xl font-bold">
            Stunden am {longDay.format(fromBerlinLocal(date))}
          </h2>
          {sp.gespeichert === "1" && (
            <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
              {chosen ? "Gespeichert – das ist die nächste offene Stunde." : "Gespeichert."}
            </p>
          )}
          {chosen && (
            <>
              <nav aria-label="Offene Stunden" className="flex flex-wrap items-center gap-2">
                {[
                  { href: openHref(nb.prev), text: "Vorherige offene Stunde", arrow: "↑", key: "ArrowUp" },
                  { href: openHref(nb.next), text: "Nächste offene Stunde", arrow: "↓", key: "ArrowDown" },
                ].map((x) =>
                  x.href ? (
                    <Button key={x.key} asChild size="sm">
                      <Link href={x.href} aria-keyshortcuts={x.key}>
                        <span aria-hidden>{x.arrow}</span> {x.text}
                      </Link>
                    </Button>
                  ) : null,
                )}
                <Button asChild size="sm" variant="ghost">
                  <Link href={closeHref!} aria-keyshortcuts="Escape">
                    Stunde schließen
                  </Link>
                </Button>
              </nav>
              <ArbeitsplatzTasten prev={openHref(nb.prev)} next={openHref(nb.next)} close={closeHref} suggestions={Math.min(3, chosenSuggestions.length)} />
            </>
          )}
          {!target ? (
            <EmptyState title="Keine Stunde gewählt">Wähle eine offene Stunde aus dem Vertretungsbedarf oder eine Lehrkraft bzw. Klasse unter „Anzeigen“.</EmptyState>
          ) : targetLessons.length === 0 ? (
            <EmptyState title="An diesem Tag keine Stunden" />
          ) : (
            <>
              {chosen && targetLessons.length > 1 && (
                <nav aria-label="Weitere Stunden" className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted">{target.kind === "teacher" ? "Stunden der Lehrkraft:" : `Stunden ${chosen.groupName}:`}</span>
                  {targetLessons.map((l) => (
                    <Link
                      key={l.lessonId}
                      href={lessonHref(l.lessonId)}
                      aria-current={l.lessonId === chosen!.lessonId ? "true" : undefined}
                      className="rounded-full border border-border bg-surface px-2.5 py-0.5 hover:border-border-strong aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft aria-[current=true]:text-accent-ink"
                    >
                      {l.periodNr}. {l.change?.insteadOf ?? l.subjectName}
                    </Link>
                  ))}
                  <Link href={workplaceHref(targetParams, "#lessons-title")} className="font-medium text-accent-ink hover:underline">
                    alle zeigen
                  </Link>
                </nav>
              )}
              {lessons.map((l, i) => {
                const d = slotDisplay(l, target!.kind === "teacher" ? "teacher" : "group");
                const existing = changes.find((c) => c.lessonId === l.lessonId);
                // SP-12: Kopf und Feldnamen mit dem regulären Fach; bei Fachtausch steht das neue daneben
                const regularSubject = l.change?.insteadOf ?? l.subjectName;
                const regularSubjectId = l.change?.insteadOfId ?? l.subjectId;
                const label = `${l.periodNr}. Std · ${regularSubject} · ${l.groupName}`;
                const lessonHistory = historyOf(l.lessonId);
                const isChosen = l.lessonId === chosen?.lessonId;
                return (
                  <Card key={l.lessonId} aria-label={isChosen ? `Gewählte Stunde: ${label}` : undefined} className={`@container gap-3${isChosen ? " border-accent" : ""}`}>
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
                      <div className="flex flex-wrap items-center gap-2">
                        {d.tag && <Badge tone={d.tone === "sub" ? "warn" : "neutral"}>{d.tag}</Badge>}
                        {!isChosen && (
                          <Button asChild size="sm" variant="ghost">
                            <Link href={lessonHref(l.lessonId)} aria-label={`Stunde wählen: ${label}`}>
                              Wählen
                            </Link>
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* VT-03a: Kenntnisnahme und Verlauf der Stunde (vorher Spalte/Aufklapper in „Alle Änderungen“) */}
                    {(existing || lessonHistory.length > 0) && (
                      <div className="flex flex-col gap-1 text-sm">
                        {ack && existing?.kind === "substitute" && (
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="text-muted">Gesehen:</span>
                            {existing.draft ? (
                              <span className="text-muted">nach dem Veröffentlichen</span>
                            ) : existing.internal?.acknowledgedAt ? (
                              <>
                                <Badge tone="success">gesehen</Badge>
                                <span className="text-muted">{stamp.format(existing.internal.acknowledgedAt)}</span>
                              </>
                            ) : (
                              <Badge tone="warn">offen</Badge>
                            )}
                          </p>
                        )}
                        {lessonHistory.length > 0 && (
                          <details open={isChosen} className="text-xs">
                            <summary className="cursor-pointer font-medium">Verlauf ({lessonHistory.length})</summary>
                            <ol aria-label={`Verlauf: ${l.groupName} ${l.periodNr}. Std`} className="mt-1 flex flex-col gap-0.5">
                              {lessonHistory.map((h) => (
                                <li key={h.id}>
                                  {stamp.format(h.createdAt)} · {describeChange(h)}
                                  {h.actorId && ` · ${actors.get(h.actorId) ?? "–"}`}
                                </li>
                              ))}
                            </ol>
                          </details>
                        )}
                      </div>
                    )}
                    {suggestions[i]!.length > 0 && (
                      <div aria-label={`Vorschläge: ${label}`} role="group" className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
                        <span className="text-xs font-semibold tracking-wide text-muted uppercase">Vorschläge</span>
                        <ol className="grid gap-2 @2xl:grid-cols-3">
                          {suggestions[i]!.slice(0, 3).map((c, n) => {
                            const who = c.code ?? c.name;
                            // VT-03b: Hauptknopf „übernehmen“ (bei Fachtausch mit dem eigenen Fach der Lehrkraft), daneben „nur Lehrkraft“
                            const swap = c.suggestedSubject;
                            // nach dem Übernehmen weiter zur nächsten offenen Stunde (nur in der gewählten Stunde, sonst bleibt der Stand)
                            const back = isChosen ? (afterSaveHref ?? stayHref) : here;
                            return (
                              <li key={c.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span aria-hidden className="grid size-6 place-items-center rounded-full bg-surface-2 text-xs font-semibold">
                                    {n + 1}
                                  </span>
                                  <span className="font-semibold">{c.name}</span>
                                  {c.code && <span className="text-muted">{c.code}</span>}
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {c.standby && <Badge tone="soft">Bereitschaft</Badge>}
                                  {swap && <Badge tone="warn">Fachtausch: {swap.name}</Badge>}
                                  <Badge tone={c.score > 0 ? "success" : "neutral"}>{c.score > 0 ? `+${c.score}` : c.score} Punkte</Badge>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <form action={applySuggestionAction.bind(null, l.lessonId, date, c.id, back, swap?.id ?? null)}>
                                    <Button
                                      type="submit"
                                      size="sm"
                                      variant="primary"
                                      aria-label={`${who}${swap ? ` mit ${swap.name}` : ""} übernehmen: ${label}`}
                                      aria-keyshortcuts={isChosen ? String(n + 1) : undefined}
                                      data-suggest-key={isChosen ? n + 1 : undefined}
                                      title={swap ? "Lehrkraft und Fach übernehmen" : "Lehrkraft übernehmen"}
                                    >
                                      {who}
                                      {swap ? ` mit ${swap.name}` : ""} übernehmen
                                    </Button>
                                  </form>
                                  {swap && (
                                    <form action={applySuggestionAction.bind(null, l.lessonId, date, c.id, back, null)}>
                                      <Button type="submit" size="sm" aria-label={`nur Lehrkraft ${who} übernehmen: ${label}`} title="Nur die Lehrkraft übernehmen, das Fach bleibt">
                                        nur Lehrkraft
                                      </Button>
                                    </form>
                                  )}
                                </div>
                                <details className="text-xs">
                                  <summary className="cursor-pointer font-medium">Gründe ({c.reasons.length})</summary>
                                  <ul aria-label={`Gründe: ${who}`} className="mt-1 flex flex-col gap-0.5 text-muted">
                                    {c.reasons.map((r) => (
                                      <li key={r.label}>
                                        {r.label} ({r.points > 0 ? "+" : ""}
                                        {r.points})
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                                <Link
                                  href={lessonHref(l.lessonId, { vorschlag: c.id }).replace("#lessons-title", "#context-title")}
                                  aria-current={isChosen && c.id === markedId ? "true" : undefined}
                                  className="text-xs font-medium text-accent-ink hover:underline aria-[current=true]:underline"
                                >
                                  Tag von {who}
                                </Link>
                              </li>
                            );
                          })}
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
                      nextHref={isChosen ? afterSaveHref : null}
                    />
                    {isChosen && (
                      <MaterialSection
                        label={label}
                        material={materials.get(`${l.lessonId}:${date}`) ?? null}
                        action={saveMaterialAction.bind(null, needs.open.find((o) => o.lessonId === l.lessonId && o.absence.teacherId === l.teacherId)?.absence.id ?? null, l.lessonId, date)}
                      />
                    )}
                  </Card>
                );
              })}
            </>
          )}
        </section>

        <section aria-labelledby="context-title" className="flex min-w-0 scroll-mt-4 flex-col gap-3 xl:col-start-2 2xl:col-start-3 2xl:row-start-1">
          <h2 id="context-title" className="font-display text-xl font-bold">
            Kontext
          </h2>
          {chosen ? (
            <ContextColumn chosen={chosen} classPlan={classPlan} teacher={teacherCtx} options={markOptions} markedId={markedId} lessonHref={(id) => lessonHref(id)} />
          ) : (
            <p className="text-sm text-muted">Wähle eine Stunde – dann stehen hier der Tagesplan der Klasse und der Tag der vorgeschlagenen Lehrkraft.</p>
          )}
        </section>
      </div>

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
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={workplaceHref({ datum: date, stunde: c.lessonId }, "#lessons-title")} aria-label={`Stunde öffnen: ${c.groupName} ${c.periodNr}. Std`}>
                        Öffnen
                      </Link>
                    </Button>
                    <form action={deleteSubstitutionAction.bind(null, c.id)} className="inline">
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
        {removed.length > 0 && (
          <div className="flex flex-col gap-1.5 text-sm">
            <h3 className="font-semibold">Aufgehoben</h3>
            <ul aria-label="Aufgehobene Änderungen" className="flex flex-col gap-1">
              {removed.map((r) => (
                <li key={r.lessonId} className="flex flex-wrap gap-x-2">
                  <span>
                    {r.periodNr}. Std · {r.groupName} · {r.subjectName}
                  </span>
                  <span className="text-muted">
                    aufgehoben {stamp.format(r.removedAt)}
                    {r.actorId && ` · ${actors.get(r.actorId) ?? "–"}`}
                  </span>
                  <Link href={workplaceHref({ datum: date, stunde: r.lessonId }, "#lessons-title")} className="font-medium text-accent-ink hover:underline" aria-label={`Verlauf ansehen: ${r.groupName} ${r.periodNr}. Std`}>
                    Verlauf ansehen
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
