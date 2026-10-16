import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { gradeLevels, recordArchives, schoolYears } from "@/core/db/schema";
import { moduleOn } from "@/core/modules/guard";
import { pendingAdmissions, proposeAssignment, proposeClassNames, type AdmissionCandidate } from "@/modules/anmeldung/uebernahme";
import { hasPermission } from "@/core/permissions";
import { activeHolds, listRuns, planDeletion } from "@/core/privacy/loeschlauf";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import {
  addYearAction,
  archiveGroupsAction,
  completeAction,
  handoverAction,
  promoteAction,
  reviewAction,
  startTransitionAction,
} from "@/modules/verwaltung/schuljahreswechsel-actions";
import { archiveStatus, getTransition, LEAVE, nextStep, planPromotion, type TransitionStep } from "@/modules/verwaltung/schuljahreswechsel";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AdmissionsStep, RegeneratePasswords } from "./admissions-step";
import { StepForm } from "./step-form";

export const metadata: Metadata = { title: "Schuljahreswechsel" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const day = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));
const at = (d: Date) => dateFmt.format(d);

const STEPS: { id: TransitionStep; label: string }[] = [
  { id: "promote", label: "Versetzung und Abgänge" },
  { id: "admissions", label: "Neuaufnahmen" },
  { id: "archive_export", label: "Klassenbücher exportieren" },
  { id: "archive_groups", label: "Gruppen archivieren" },
  { id: "review", label: "Löschprotokoll und Sperren prüfen" },
  { id: "complete", label: "Abschließen" },
];

export default async function SchuljahreswechselPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "verwaltung.privacy")) notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [current] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const openArchives = await db
    .select()
    .from(recordArchives)
    .where(and(isNull(recordArchives.handedOverAt), isNotNull(recordArchives.groupId)))
    .orderBy(recordArchives.schoolYearName, recordArchives.groupName);

  if (!current)
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Verwaltung" title="Schuljahreswechsel" />
        <EmptyState title="Kein aktuelles Schuljahr">
          Unter <Link href="/verwaltung/stammdaten">Stammdaten → Schuljahre</Link> ein Schuljahr anlegen.
        </EmptyState>
      </main>
    );

  const t = await getTransition(db, current.id);
  const later = await db.select().from(schoolYears).where(gt(schoolYears.startsOn, current.endsOn)).orderBy(schoolYears.startsOn);
  const to = t ? (await db.select().from(schoolYears).where(eq(schoolYears.id, t.toYearId)))[0] : undefined;
  const archives = await archiveStatus(db, current.id);
  const missing = archives.filter((a) => !a.archive).length;
  // P4-39: Neuaufnahmen aus der Schulanmeldung, nur mit eingeschaltetem Modul und aufgenommenen Anträgen
  const admissions = t && !t.completedAt && (await moduleOn("anmeldung")) ? await pendingAdmissions(db, t.toYearId) : [];
  const stepNow = t ? nextStep(t, missing, admissions.length) : null;
  const steps = STEPS.filter((s) => s.id !== "admissions" || admissions.length > 0 || t?.admittedAt);
  const doneIdx = stepNow ? steps.findIndex((s) => s.id === stepNow) : -1;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Schuljahreswechsel" />
      <p className="max-w-3xl text-sm text-muted">
        Führt vom Schuljahr {current.name} ins nächste: Versetzung, Abgänge, Archivexport der Klassenbücher (Aktenpflicht § 9 VO-DV I),
        Archivieren der alten Gruppen und die jährliche Prüfung von Löschprotokoll und Löschsperren (DATENSCHUTZ.md §3.8).
      </p>

      {openArchives.length > 0 && (
        <Card aria-label="Archivexporte ohne Übergabe" className="border-warn">
          <CardHeader title={`Archivexporte ohne bestätigte Übergabe (${openArchives.length})`} />
          <p className="text-sm text-muted">
            Solange die Übergabe nicht bestätigt ist, lässt der Löschlauf das Klassenbuch stehen. Bestätigen, sobald der Export sicher verwahrt
            ist (Schule bzw. Schulträger, 10 Jahre).
          </p>
          <ul className="flex flex-col gap-2">
            {openArchives.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 first:border-t-0">
                <span>
                  <span className="font-medium">{a.groupName}</span> <span className="text-muted">· {a.schoolYearName} · exportiert am {at(a.exportedAt)}</span>
                </span>
                <form action={handoverAction}>
                  <input type="hidden" name="groupId" value={a.groupId!} />
                  <Button type="submit" size="sm" aria-label={`Übergabe ${a.groupName} bestätigen`}>
                    Übergabe bestätigen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!t ? (
        <Card aria-label="Wechsel starten">
          <CardHeader title={`Neues Schuljahr nach ${current.name}`} />
          {later.length === 0 ? (
            <form action={addYearAction} className="flex flex-col gap-3">
              <p className="text-sm text-muted">Es gibt noch kein Schuljahr nach {current.name}.</p>
              <div>
                <Button type="submit" variant="primary">
                  Folgejahr anlegen
                </Button>
              </div>
            </form>
          ) : (
            <StepForm action={startTransitionAction} label="Wechsel starten" submit="Schuljahreswechsel starten" hidden={{ fromYearId: current.id }}>
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Neues Schuljahr
                <Select name="toYearId" defaultValue={later[0]!.id} className="w-64">
                  {later.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name} ({day(y.startsOn)} – {day(y.endsOn)})
                    </option>
                  ))}
                </Select>
              </label>
            </StepForm>
          )}
        </Card>
      ) : (
        <>
          <ol aria-label="Schritte" className={steps.length > 5 ? "grid gap-2 sm:grid-cols-6" : "grid gap-2 sm:grid-cols-5"}>
            {steps.map((s, i) => {
              const state = stepNow === "done" || i < doneIdx ? "done" : i === doneIdx ? "now" : "open";
              return (
                <li key={s.id} aria-current={state === "now" ? "step" : undefined} className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-3 text-sm">
                  <span className="text-xs text-muted">Schritt {i + 1}</span>
                  <span className="font-medium">{s.label}</span>
                  <Badge tone={state === "done" ? "success" : state === "now" ? "warn" : undefined}>
                    {state === "done" ? "erledigt" : state === "now" ? "jetzt" : "offen"}
                  </Badge>
                </li>
              );
            })}
          </ol>
          <Card aria-label="Aktueller Schritt">
            <CardHeader title={`${current.name} → ${to?.name ?? "?"}`} />
            {stepNow === "promote" && <PromoteStep transitionId={t.id} yearId={current.id} />}
            {stepNow === "admissions" && <AdmissionsStepServer transitionId={t.id} candidates={admissions} canCreate={hasPermission(perms, "verwaltung.users")} />}
            {stepNow === "archive_export" && <ArchiveExportStep archives={archives} />}
            {stepNow === "archive_groups" && (
              <StepForm action={archiveGroupsAction} label="Gruppen archivieren" submit={`Gruppen von ${current.name} archivieren`} hidden={{ transitionId: t.id }}>
                <p className="text-sm text-muted">
                  Alle Klassen, Kurse und AGs des Schuljahres {current.name} werden archiviert: Die Mitgliedschaften enden, die Gruppen
                  verschwinden aus den Listen. Inhalte (Stundenplan, Klassenbuch, Aufgaben) bleiben bis zu ihrer Löschfrist erhalten.
                </p>
              </StepForm>
            )}
            {stepNow === "review" && <ReviewStep transitionId={t.id} today={today} />}
            {stepNow === "complete" && (
              <StepForm action={completeAction} label="Abschließen" submit="Schuljahreswechsel abschließen" hidden={{ transitionId: t.id }}>
                <p className="text-sm text-muted">
                  {to?.name} wird das aktuelle Schuljahr. {t.leavers.length} Abgänger:innen werden zum {day(current.endsOn)} abgemeldet
                  (Konto gesperrt, Löschung nach der Frist über den Löschlauf); Elternkonten ohne weiteres Kind folgen.
                </p>
              </StepForm>
            )}
          </Card>
          {t.admittedAt && !t.completedAt && t.admittedUsers.length > 0 && hasPermission(perms, "verwaltung.users") && (
            <Card aria-label="Neuaufnahmen: Startpasswörter">
              <CardHeader title="Neuaufnahmen: Startpasswörter" />
              <RegeneratePasswords transitionId={t.id} count={t.admittedUsers.length} />
            </Card>
          )}
        </>
      )}
    </main>
  );
}

async function PromoteStep({ transitionId, yearId }: { transitionId: string; yearId: string }) {
  const plan = await planPromotion(await getDb(), yearId);
  const targets = [...new Set(plan.map((c) => c.proposal).filter((x): x is string => Boolean(x)))];
  if (!plan.length) return <EmptyState title="Keine Klassen im Schuljahr" />;
  return (
    <StepForm action={promoteAction} label="Versetzung" submit="Versetzung durchführen" hidden={{ transitionId }}>
      <p className="text-sm text-muted">
        Je Klasse der Name im neuen Schuljahr (gleiche Namen werden zusammengelegt, leer = alle gehen ab). Einzelne Schüler:innen lassen
        sich umsetzen (z. B. Wiederholung) oder als Abgang markieren.
      </p>
      <ul className="flex flex-col gap-3">
        {plan.map((c) => (
          <li key={c.groupId} className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-end gap-3">
              <span className="min-w-28 font-medium">
                {c.name} <span className="block text-xs font-normal text-muted">{c.students.length} Schüler:innen</span>
              </span>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted">wird zu</span>
                <Input name={`to:${c.groupId}`} defaultValue={c.proposal ?? ""} placeholder="leer = Abgang" aria-label={`${c.name} wird zu`} className="w-48" />
              </label>
              {c.leaders.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`lead:${c.groupId}`} value="1" defaultChecked className="size-4 accent-[var(--accent)]" />
                  Leitung ({c.leaders.map((l) => l.name).join(", ")}) übernehmen
                </label>
              )}
              {!c.proposal && <Badge tone="warn">Abschlussjahrgang</Badge>}
            </div>
            {c.students.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm text-muted">Schüler:innen einzeln</summary>
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {c.students.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">{s.name}</span>
                      <Select name={`s:${s.id}`} defaultValue="" aria-label={`Ziel für ${s.name}`} className="h-9 w-36 text-sm">
                        <option value="">mit der Klasse</option>
                        {targets.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                        <option value={LEAVE}>Abgang</option>
                      </Select>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </StepForm>
  );
}

function ArchiveExportStep({ archives }: { archives: Awaited<ReturnType<typeof archiveStatus>> }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Jedes Klassenbuch als ZIP herunterladen (Druckansicht, maschinenlesbare Daten, Fristen und Vermerk) und bei der Schule bzw. dem
        Schulträger verwahren. Danach geht es weiter; die Übergabe lässt sich auch später bestätigen.
      </p>
      <Table>
        <caption className="sr-only">Klassenbücher</caption>
        <thead>
          <tr>
            <th>Gruppe</th>
            <th className="text-right">Einträge</th>
            <th>Export</th>
          </tr>
        </thead>
        <tbody>
          {archives.map((a) => (
            <tr key={a.id}>
              <td className="font-medium">{a.name}</td>
              <td className="text-right tabular-nums">{a.entries}</td>
              <td>
                <span className="flex flex-wrap items-center gap-2">
                  {/* POST statt Link (SEC-05): der Export setzt den Archivvermerk */}
                  <form method="post" action={`/api/klassenbuch/archiv/${encodeURIComponent(a.id)}`}>
                    <Button type="submit" size="sm" variant={a.archive ? "secondary" : "primary"}>
                      {a.archive ? "erneut herunterladen" : "Archivexport herunterladen"}
                    </Button>
                  </form>
                  {a.archive && <Badge tone="success">exportiert am {at(a.archive.exportedAt)}</Badge>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="text-sm">
        <Link href="/verwaltung/schuljahreswechsel" className="underline">
          Stand aktualisieren
        </Link>
      </p>
    </div>
  );
}

async function ReviewStep({ transitionId, today }: { transitionId: string; today: string }) {
  const db = await getDb();
  const [plan, holds, [lastRun]] = await Promise.all([planDeletion(db, today), activeHolds(db, today), listRuns(db, 1)]);
  const due = plan.filter((p) => p.status === "due" && p.count > 0);
  return (
    <StepForm action={reviewAction} label="Prüfung" submit="Geprüft" hidden={{ transitionId }}>
      <ul className="flex flex-col gap-1 text-sm">
        <li>
          Löschlauf heute: <strong>{due.reduce((s, p) => s + p.count, 0)}</strong> Datensätze fällig in {due.length} Datenarten
        </li>
        <li>Letzter Löschlauf: {lastRun ? at(lastRun.startedAt) : "noch keiner"}</li>
        <li>Aktive Löschsperren: {holds.length}</li>
      </ul>
      <p className="text-sm">
        <Link href="/verwaltung/datenschutz/loeschlauf" className="underline">
          Löschprotokoll und Sperren ansehen
        </Link>
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" value="1" className="mt-0.5 size-4 accent-[var(--accent)]" />
        Löschprotokoll, Löschsperren und nicht übergebene Archivexporte sind geprüft.
      </label>
    </StepForm>
  );
}

const birthFmt = (ymd: string) => ymd.split("-").reverse().join(".");

async function AdmissionsStepServer({ transitionId, candidates, canCreate }: { transitionId: string; candidates: AdmissionCandidate[]; canCreate: boolean }) {
  const all = await (await getDb()).select().from(gradeLevels);
  const levelIds = [...new Set(candidates.map((c) => c.gradeLevel))].sort((a, b) => a - b);
  const levels = levelIds.map((level) => {
    const g = all.find((x) => x.level === level);
    const mine = candidates.filter((c) => c.gradeLevel === level);
    return { level, name: g?.name ?? `Jahrgang ${level}`, classes: proposeClassNames(g?.code ?? String(level), mine.length) };
  });
  const proposal = Object.assign({}, ...levels.map((l) => proposeAssignment(candidates.filter((c) => c.gradeLevel === l.level), l.classes))) as Record<string, string>;
  return (
    <AdmissionsStep
      transitionId={transitionId}
      canCreate={canCreate}
      levels={levels}
      proposal={proposal}
      rows={candidates.map((c) => ({
        antragId: c.antragId,
        number: c.number,
        child: `${c.childLastName}, ${c.childFirstName}`,
        birth: birthFmt(c.childBirthDate),
        school: c.primarySchool ?? "",
        sibling: c.sibling ? c.siblingNote || "ja" : null,
        parent: c.parent1Name,
        existingParent: c.existingParent?.name ?? null,
        suggestedParent: c.suggestedParent ? `${c.suggestedParent.name}${c.suggestedParent.username ? ` (${c.suggestedParent.username})` : ""}` : null,
        parent2: c.parent2
          ? {
              name: c.parent2.name,
              suggested: !c.parent2.suggestion
                ? null
                : c.parent2.suggestion.kind === "konto"
                  ? `${c.parent2.suggestion.name}${c.parent2.suggestion.username ? ` (${c.parent2.suggestion.username})` : ""}`
                  : `${c.parent2.suggestion.name} (Elternteil 1 in ${c.parent2.suggestion.number})`,
              why: !c.parent2.suggestion
                ? null
                : c.parent2.suggestion.kind === "konto"
                  ? `Konto mit der Adresse aus dem Antrag${c.parent2.suggestion.verified ? "" : " (am Konto unbestätigt)"} – die Angabe im Antrag ist nicht von Elternteil 2 bestätigt`
                  : "gleiche Adresse wie Elternteil 1 eines anderen Antrags – die Angabe hier ist nicht von Elternteil 2 bestätigt",
            }
          : null,
        gradeLevel: c.gradeLevel,
      }))}
    />
  );
}
