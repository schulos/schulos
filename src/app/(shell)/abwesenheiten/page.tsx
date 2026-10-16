import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auditRead } from "@/core/audit";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { toBerlinDate } from "@/core/time";
import { decideDayAction, decideReportAction, reportAbsenceAction } from "@/modules/abwesenheiten/actions";
import { leaderLeaves, leavesFor, principalLeaves } from "@/modules/abwesenheiten/beurlaubung";
import { isSelfResponsible } from "@/core/school/majority";
import { openDays, ownAbsences } from "@/modules/abwesenheiten/fehlzeiten";
import { ForbiddenError, hasPermission } from "@/core/permissions";
import { leaderView, parentView, phoneStudents, rangeLabel, REASON_LABEL, selfView, STATUS_LABEL, type ReportRow } from "@/modules/abwesenheiten/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { planDays } from "@/modules/stundenplan/vertretung";
import { Fehlzeiten } from "./fehlzeiten";
import { DecideButtons, LeaveList } from "./leave-ui";
import { AbsencePrivacyNote, WrittenExcuseHint } from "./privacy-note";
import { excusesArchived } from "@/modules/klassenbuch/entschuldigungen";
import { ReportForm } from "./report-form";

export const metadata: Metadata = { title: "Abwesenheiten" };

/** Eigenständige Kinder ohne Einwilligung (Q5-05) sieht ein Elternteil nicht – alles andere ist ein echter Fehler */
function onlyForbidden(err: unknown): null {
  if (err instanceof ForbiddenError) return null;
  throw err;
}

const TONE = { gemeldet: "warn", entschuldigt: "success", nicht_entschuldigt: "danger" } as const;

function ReportItem({ r, showClass, actions }: { r: ReportRow; showClass: boolean; actions?: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <span className="flex flex-col leading-tight">
        <span className="font-medium">
          {r.studentName}
          {showClass && r.groupName && <span className="font-normal text-muted"> · {r.groupName}</span>}
        </span>
        <span className="text-sm text-muted">
          {rangeLabel(r.fromDate, r.toDate)} · {r.reason ? REASON_LABEL[r.reason] : "Grund ausgeblendet"}
          {r.reportedByName && ` · gemeldet von ${r.reportedByName}`}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {actions ?? <Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>}
      </span>
    </li>
  );
}

/** Q5-16: Antrag und eigene Anträge liegen unter /abwesenheiten/beurlaubung */
function LeaveLink({ open = 0, self = false }: { open?: number; self?: boolean }) {
  return (
    <Card aria-labelledby="beurlaubung" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col leading-tight">
        <h2 id="beurlaubung" className="text-base font-semibold">
          Beurlaubung vorab
        </h2>
        <p className="text-sm text-muted">
          Für Tage, an denen {self ? "du" : "das Kind"} aus einem wichtigen Grund nicht zur Schule {self ? "kommen kannst" : "kommen kann"} – rechtzeitig vorher beantragen.
        </p>
      </div>
      <span className="flex items-center gap-2">
        {open > 0 && <Badge tone="warn">{open} beantragt</Badge>}
        <Button asChild size="sm">
          <Link href="/abwesenheiten/beurlaubung">Beurlaubung beantragen</Link>
        </Button>
      </span>
    </Card>
  );
}

export default async function AbwesenheitenPage() {
  const { user, perms } = await requireUser();
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  // Vorschlag fürs Formular: heute, am Wochenende der Montag
  const todayYmd = toBerlinDate(new Date());
  const today = planDays(todayYmd, cal)[0];
  // DS-16: gilt die digitale Meldung als schriftliche Entschuldigung? (sonst Hinweis „zusätzlich schriftlich“)
  const archived = await excusesArchived(db);

  if (user.role === "schueler") {
    // Q5-13: eigene Fehlzeiten
    const own = await ownAbsences(db, perms, user.id, todayYmd);
    // DS-19/Q5-16: eigenständige (volljährige) Schüler:innen melden Abwesenheiten und beantragen Beurlaubungen selbst
    const self = await isSelfResponsible(db, user.id);
    const mine = self ? ((await selfView(db, user.id)) ?? []) : [];
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Abwesenheiten" title={self ? "Abwesenheiten" : "Meine Fehlzeiten"} />
        {self && (
          <>
            <Card aria-labelledby="melden">
              <h2 id="melden" className="text-base font-semibold">
                Abwesenheit melden
              </h2>
              <ReportForm
                action={reportAbsenceAction}
                students={[{ id: user.id, label: user.name }]}
                today={today}
                submitLabel="Abwesenheit melden"
                successText="Gemeldet – deine Klassenleitung ist benachrichtigt."
              />
              {!archived && <WrittenExcuseHint self />}
              <AbsencePrivacyNote kind="meldung" self archived={archived} />
            </Card>
            <section aria-labelledby="meine" className="flex flex-col gap-3">
              <h2 id="meine" className="font-display text-xl font-bold">
                Meine Meldungen
              </h2>
              {mine.length === 0 ? (
                <EmptyState title="Noch keine Meldungen" />
              ) : (
                <ul className="rounded-card border border-border bg-surface px-4">
                  {mine.map((r) => (
                    <ReportItem key={r.id} r={r} showClass={false} />
                  ))}
                </ul>
              )}
            </section>
            <LeaveLink self />
          </>
        )}
        <Fehlzeiten id="fehlzeiten" title="Fehlstunden und Verspätungen" {...own} />
      </main>
    );
  }

  if (user.role === "eltern") {
    // DS-19: `kids` = minderjährige Kinder (melden, beantragen); `informed` = auch eigenständige mit Einwilligung (nur Fehlzeiten)
    const { kids, informed, reports } = await parentView(db, user.id);
    // Q5-13: Fehlzeiten der Kinder; Einsicht wird protokolliert
    const absences = await Promise.all(informed.map(async (k) => ({ kid: k, data: await ownAbsences(db, perms, k.id, todayYmd).catch(onlyForbidden) })));
    // Q5-16: Beurlaubung nur für minderjährige Kinder (eigenständige beantragen selbst)
    const minors = kids;
    const leaves = await leavesFor(db, minors.map((k) => k.id));
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Abwesenheiten" title="Krankmeldung" />
        {kids.length === 0 ? (
          <EmptyState title="Keine Kinder zum Melden">Volljährige, eigenständige Schüler:innen melden Abwesenheiten selbst.</EmptyState>
        ) : (
          <Card aria-labelledby="melden">
            <h2 id="melden" className="text-base font-semibold">
              {kids.length === 1 ? `${kids[0]!.name} abwesend melden` : "Kind abwesend melden"}
            </h2>
            <ReportForm
              action={reportAbsenceAction}
              students={kids.map((k) => ({ id: k.id, label: k.name }))}
              today={today}
              submitLabel="Abwesenheit melden"
              successText="Gemeldet – die Klassenleitung ist benachrichtigt."
            />
            {!archived && <WrittenExcuseHint />}
            <AbsencePrivacyNote kind="meldung" archived={archived} />
          </Card>
        )}
        <section aria-labelledby="meine" className="flex flex-col gap-3">
          <h2 id="meine" className="font-display text-xl font-bold">
            Meine Meldungen
          </h2>
          {reports.length === 0 ? (
            <EmptyState title="Noch keine Meldungen" />
          ) : (
            <ul className="rounded-card border border-border bg-surface px-4">
              {reports.map((r) => (
                <ReportItem key={r.id} r={r} showClass={false} />
              ))}
            </ul>
          )}
        </section>
        {minors.length > 0 && <LeaveLink open={leaves.filter((l) => l.status === "beantragt").length} />}
        {absences.map(({ kid, data }) =>
          data ? <Fehlzeiten key={kid.id} id={`fehlzeiten-${kid.id}`} title={`Fehlzeiten: ${kid.name}`} {...data} /> : null,
        )}
      </main>
    );
  }

  if (!["lehrkraft", "verwaltung", "admin"].includes(user.role)) notFound();
  const { students, reports } = await leaderView(db, perms);
  const unreported = students.length ? await openDays(db, perms, todayYmd) : [];
  const classLeaves = students.length ? await leaderLeaves(db, perms, students.map((s) => s.id)) : [];
  // Q5-16: Schulleitung entscheidet Beurlaubungen über der Grenze
  const slLeaves = hasPermission(perms, "abwesenheiten.leave_decide") ? await principalLeaves(db, perms, todayYmd) : null;
  const slOpen = slLeaves?.filter((r) => r.status === "beantragt").length ?? 0;
  const klOpen = classLeaves.filter((r) => r.canDecide).length;
  await auditRead(db, user.id, "lesen.abwesenheiten", null, { reports: reports.length });
  const open = reports.filter((r) => r.status === "gemeldet");
  const done = reports.filter((r) => r.status !== "gemeldet");
  const manyClasses = new Set(students.map((s) => s.groupName)).size > 1;
  // Sekretariat: Anruf der Eltern aufnehmen (Q5-01) – die Klassenleitung entscheidet
  const phone = hasPermission(perms, "abwesenheiten.phone") ? await phoneStudents(db, perms) : null;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Abwesenheiten" title={students.length > 0 ? "Abwesenheiten meiner Klasse" : phone ? "Krankmeldung aufnehmen" : slLeaves ? "Beurlaubungen" : "Abwesenheiten meiner Klasse"} />
      {phone && (
        <Card aria-labelledby="telefon">
          <h2 id="telefon" className="text-base font-semibold">
            Telefonische Krankmeldung <span className="font-normal text-muted">(im Namen der Eltern)</span>
          </h2>
          <ReportForm
            action={reportAbsenceAction}
            students={phone.map((s) => ({ id: s.id, label: s.groupName ? `${s.name} (${s.groupName})` : s.name }))}
            today={today}
            submitLabel="Krankmeldung aufnehmen"
            successText="Aufgenommen – die Klassenleitung ist benachrichtigt und entscheidet."
            channel="telefon"
          />
        </Card>
      )}
      {slLeaves && (
        <section aria-labelledby="beurlaubungen-sl" className="flex flex-col gap-3">
          <h2 id="beurlaubungen-sl" className="font-display text-xl font-bold">
            Beurlaubungen (Schulleitung) {slOpen > 0 && <Badge tone="warn">{slOpen}</Badge>}
          </h2>
          <LeaveList rows={slLeaves} showClass empty="Keine Anträge über der Grenze." actions={(r) => (r.status === "beantragt" ? <DecideButtons r={r} /> : undefined)} />
        </section>
      )}
      {students.length === 0 ? phone || slLeaves ? null : (
        <EmptyState title="Keine Klassenleitung">Abwesenheiten bearbeitet die Klassenleitung.</EmptyState>
      ) : (
        <>
          <section aria-labelledby="offen" className="flex flex-col gap-3">
            <h2 id="offen" className="font-display text-xl font-bold">
              Offene Meldungen {open.length > 0 && <Badge tone="warn">{open.length}</Badge>}
            </h2>
            {open.length === 0 ? (
              <p className="rounded-card border border-border bg-surface p-4 text-muted">Alles bearbeitet.</p>
            ) : (
              <ul className="rounded-card border border-border bg-surface px-4">
                {open.map((r) => (
                  <ReportItem
                    key={r.id}
                    r={r}
                    showClass={manyClasses}
                    actions={
                      <>
                        <form action={decideReportAction.bind(null, r.id, true)}>
                          <Button type="submit" size="sm" variant="primary" aria-label={`Entschuldigen: ${r.studentName}`}>
                            Entschuldigen
                          </Button>
                        </form>
                        <form action={decideReportAction.bind(null, r.id, false)}>
                          <Button type="submit" size="sm" aria-label={`Nicht entschuldigen: ${r.studentName}`}>
                            Nicht entschuldigen
                          </Button>
                        </form>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="ohne-meldung" className="flex flex-col gap-3">
            <h2 id="ohne-meldung" className="font-display text-xl font-bold">
              Fehltage ohne Meldung {unreported.length > 0 && <Badge tone="warn">{unreported.length}</Badge>}
            </h2>
            <p className="text-sm text-muted">
              Fehlstunden der letzten 30 Tage, für die keine Meldung vorliegt. Erst „Nicht entschuldigt“ benachrichtigt die Eltern.
            </p>
            {unreported.length === 0 ? (
              <p className="rounded-card border border-border bg-surface p-4 text-muted">Keine offenen Fehltage.</p>
            ) : (
              <ul className="rounded-card border border-border bg-surface px-4">
                {unreported.map((d) => (
                  <li key={`${d.studentId}-${d.date}`} className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
                    <span className="flex flex-col leading-tight">
                      <span className="font-medium">
                        {d.studentName}
                        {manyClasses && <span className="font-normal text-muted"> · {d.groupName}</span>}
                      </span>
                      <span className="text-sm text-muted">
                        {rangeLabel(d.date, d.date)} · {d.hours} {d.hours === 1 ? "Fehlstunde" : "Fehlstunden"}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <form action={decideDayAction.bind(null, d.studentId, d.date, true)}>
                        <Button type="submit" size="sm" aria-label={`Fehltag entschuldigen: ${d.studentName} ${rangeLabel(d.date, d.date)}`}>
                          Entschuldigen
                        </Button>
                      </form>
                      <form action={decideDayAction.bind(null, d.studentId, d.date, false)}>
                        <Button type="submit" size="sm" aria-label={`Fehltag nicht entschuldigen: ${d.studentName} ${rangeLabel(d.date, d.date)}`}>
                          Nicht entschuldigt
                        </Button>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="beurlaubungen" className="flex flex-col gap-3">
            <h2 id="beurlaubungen" className="font-display text-xl font-bold">
              Beurlaubungen {klOpen > 0 && <Badge tone="warn">{klOpen}</Badge>}
            </h2>
            <LeaveList
              rows={classLeaves}
              showClass={manyClasses}
              empty="Keine Anträge."
              actions={(r) => {
                if (classLeaves.find((x) => x.id === r.id)?.canDecide) return <DecideButtons r={r} />;
                return r.status === "beantragt" ? <Badge tone="warn">bei der Schulleitung</Badge> : undefined;
              }}
            />
          </section>

          <Card aria-labelledby="erfassen">
            <h2 id="erfassen" className="text-base font-semibold">
              Entschuldigung erfassen <span className="font-normal text-muted">(z. B. schriftlich abgegeben)</span>
            </h2>
            <ReportForm
              action={reportAbsenceAction}
              students={students.map((s) => ({ id: s.id, label: manyClasses ? `${s.name} (${s.groupName})` : s.name }))}
              today={today}
              submitLabel="Als entschuldigt erfassen"
              successText="Erfasst – die Fehlstunden im Klassenbuch sind entschuldigt."
            />
          </Card>

          <section aria-labelledby="verlauf" className="flex flex-col gap-3">
            <h2 id="verlauf" className="font-display text-xl font-bold">
              Verlauf
            </h2>
            {done.length === 0 ? (
              <EmptyState title="Noch nichts entschieden" />
            ) : (
              <ul className="rounded-card border border-border bg-surface px-4">
                {done.map((r) => (
                  <ReportItem key={r.id} r={r} showClass={manyClasses} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
