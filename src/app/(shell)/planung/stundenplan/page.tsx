import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pin, Plus, Wand2 } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { eq } from "drizzle-orm";
import { schoolYears } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
import { copyPeriodAction, toggleFixedAction, deleteCouplingAction, deleteLessonAction, moveLessonAction, placeAssignmentAction, saveCouplingAction, saveLessonAction } from "@/modules/stundenplan/actions";
import { coupledGroupLabel } from "@/modules/stundenplan/display";
import { periodPreview } from "@/modules/stundenplan/periode";
import { ValidationError } from "@/modules/verwaltung/users";
import { DIAGNOSIS_LABELS, groupPlanFindings } from "@/modules/stundenplan/diagnose";
import { couplingParts, defaultValidity, lessonsOfGroup, plannableGroups, suggestRoom, teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { assignmentPlacement, movePlacement, moveGridInput, openAssignments, placementGrid, type Cell } from "@/modules/stundenplan/setzhilfe";
import { PLANNED_GROUP_KINDS } from "@/modules/stundenplan/verteilung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { CouplingForm, type CouplingFormValues } from "./coupling-form";
import { LessonForm, type LessonFormValues } from "./lesson-form";
import { MoveLink, OpenPanel, PlacementCell } from "./setzhilfe-ui";
import { FindingList } from "@/app/(shell)/planung/unterricht/diagnosis";

export const metadata: Metadata = { title: "Stundenplan pflegen" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmtYmd = (ymd: string) => dateFmt.format(new Date(`${ymd}T00:00:00Z`));

type Search = { stand?: string; periode?: string; kopiert?: string; ab?: string; gruppe?: string; neu?: string; stunde?: string; kopplung?: string; von?: string; setzen?: string; verschieben?: string; fehler?: string };

export default async function StundenplanPflegePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [groupList, master, teachers] = await Promise.all([plannableGroups(db), timetableMasterData(db), teacherOptions(db)]);
  const group = groupList.find((g) => g.id === sp.gruppe);
  // Planungsstand: heute oder der Beginn einer künftigen Periode (nach „Periode kopieren“)
  const stand = sp.stand && /^\d{4}-\d{2}-\d{2}$/.test(sp.stand) && sp.stand > today ? sp.stand : undefined;
  const view = stand ?? today;

  const header = (
    <>
      <PageHeader
        eyebrow="Stundenplanung"
        title="Stundenplan pflegen"
        actions={
          <Button asChild>
            <Link href="/planung/solver">
              <Wand2 aria-hidden /> Automatisch planen
            </Link>
          </Button>
        }
      />
      <form className="flex flex-wrap items-end gap-3">
        <Select name="gruppe" defaultValue={group?.id ?? ""} aria-label="Klasse oder Kurs" className="w-72">
          <option value="">Klasse oder Kurs wählen</option>
          {PLANNED_GROUP_KINDS.filter((k) => groupList.some((g) => g.kind === k)).map((kind) => (
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
        {stand && <input type="hidden" name="stand" value={stand} />}
        <Button type="submit">Anzeigen</Button>
      </form>
    </>
  );
  if (!group) {
    return (
      <main className="flex flex-col gap-6">
        {header}
        {sp.kopiert !== undefined && (
          <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
            {sp.kopiert === "0"
              ? "Es lief keine Stunde über den Stichtag – nichts kopiert."
              : `${sp.kopiert} Stunden ab ${sp.ab ? fmtYmd(sp.ab) : "dem Stichtag"} kopiert. Gruppe wählen, um den neuen Plan zu bearbeiten.`}
          </p>
        )}
        <EmptyState title="Keine Gruppe gewählt">Wähle eine Klasse, einen Kurs oder eine AG, um ihren Stundenplan zu bearbeiten.</EmptyState>
        <PeriodCard cutoff={sp.periode} error={sp.fehler} suggestion={await suggestedCutoff(db, today)} today={today} />
      </main>
    );
  }

  const upcoming = await lessonsOfGroup(db, group.id, view);
  const lessons = upcoming.filter((r) => r.l.validFrom <= view);
  // künftige Perioden der Gruppe (Stunden, die erst später beginnen)
  const periodStarts = [...new Set(upcoming.map((r) => r.l.validFrom).filter((d) => d > today))].sort().slice(0, 4);
  const parts = await couplingParts(db, [...new Set(lessons.map((r) => r.l.couplingId).filter((c): c is string => Boolean(c)))]);
  const partsOf = (cid: string) => parts.filter((p) => p.couplingId === cid);
  const base = `/planung/stundenplan?gruppe=${encodeURIComponent(group.id)}${stand ? `&stand=${stand}` : ""}`;
  const groupBase = `/planung/stundenplan?gruppe=${encodeURIComponent(group.id)}`;
  // Setzhilfe: offene Lehraufträge, Freiraster beim Setzen bzw. Verschieben
  const [open, planFindings] = await Promise.all([openAssignments(db, group.id, view), groupPlanFindings(db, group.id, view)]);
  const placing = sp.setzen ? open.find((a) => a.id === sp.setzen) : undefined;
  const moving = !placing && sp.verschieben ? lessons.find((r) => r.l.id === sp.verschieben) : undefined;
  const gridDims = [WEEKDAYS.map((_, i) => i), master.periods.map((p) => p.nr)] as const;
  let grid: Map<string, Cell> | null = null;
  if (placing) grid = placementGrid({ ...(await assignmentPlacement(db, placing, today, stand)), unitIds: [], weekdays: [...gridDims[0]], periods: [...gridDims[1]] });
  else if (moving) {
    const m = await movePlacement(db, moving.l.id);
    if (m?.unit.length) grid = placementGrid(moveGridInput(m, group.id, [...gridDims[0]], [...gridDims[1]]));
  }
  const modeOn = Boolean(grid);
  const yearEnd = (await defaultValidity(db, today)).validUntil;
  const endsEarly = (until: string | null) => until !== null && (yearEnd === null || until < yearEnd);

  const editing = !modeOn && sp.stunde ? lessons.find((r) => r.l.id === sp.stunde && !r.l.couplingId) : undefined;
  const [newDay, newPeriod] = (sp.neu ?? "").split("-").map(Number);
  const creating = !editing && sp.neu !== undefined && Number.isInteger(newDay) && Number.isInteger(newPeriod);
  const options = {
    weekdays: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })),
    periods: master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde (${p.startsAt}–${p.endsAt})` })),
    subjects: master.subjects.map((s) => ({ value: s.id, label: s.name })),
    teachers: teachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.name}` })),
    rooms: master.rooms.map((r) => ({ value: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` })),
  };

  let form: React.ReactNode = null;
  // Kopplung: bestehende bearbeiten, aus einer Einzelstunde erweitern oder neu im Slot anlegen
  const coupledRow = sp.kopplung && sp.kopplung !== "neu" ? lessons.find((r) => r.l.couplingId === sp.kopplung) : undefined;
  const fromLesson = sp.kopplung === "neu" && sp.von ? lessons.find((r) => r.l.id === sp.von && !r.l.couplingId) : undefined;
  if (coupledRow || fromLesson || (sp.kopplung === "neu" && creating)) {
    const validity = await defaultValidity(db, today, stand);
    const slotOf = coupledRow ?? fromLesson;
    const empty = { id: "", groupId: group.id, subjectId: "", teacherId: "", roomId: "" };
    const initial: CouplingFormValues = {
      weekday: String(slotOf?.l.weekday ?? newDay),
      periodNr: String(slotOf?.l.periodNr ?? newPeriod),
      week: slotOf?.l.week ?? "all",
      validFrom: slotOf?.l.validFrom ?? validity.validFrom,
      validUntil: (slotOf ? slotOf.l.validUntil : validity.validUntil) ?? "",
      parts: coupledRow
        ? partsOf(coupledRow.l.couplingId!).map((p) => ({ id: p.id, groupId: p.groupId, subjectId: p.subjectId, teacherId: p.teacherId ?? "", roomId: p.roomId ?? "" }))
        : fromLesson
          ? [{ id: fromLesson.l.id, groupId: group.id, subjectId: fromLesson.l.subjectId, teacherId: fromLesson.l.teacherId ?? "", roomId: fromLesson.l.roomId ?? "" }, empty]
          : [empty, empty],
    };
    form = (
      <Card aria-labelledby="coupling-form-title">
        <h2 id="coupling-form-title" className="text-base font-semibold">
          {coupledRow ? "Kopplung bearbeiten" : "Kopplung anlegen"} · {group.name}
        </h2>
        {coupledRow && <MoveLink href={`${base}&verschieben=${coupledRow.l.id}`} />}
        {coupledRow && <FixToggle action={toggleFixedAction.bind(null, coupledRow.l.id, group.id, !coupledRow.l.fixed, stand ?? null)} fixed={coupledRow.l.fixed} />}
        <p className="text-sm text-muted">
          Alle Teile liegen zur selben Zeit: geteilte Klasse (z. B. Religion/Philosophie), Kurse über Klassen hinweg, eine Lehrkraft für mehrere Gruppen oder
          Teamteaching im selben Raum.
        </p>
        <CouplingForm
          key={coupledRow?.l.couplingId ?? `neu-${sp.von ?? sp.neu}`}
          action={saveCouplingAction.bind(null, coupledRow?.l.couplingId ?? null, group.id)}
          deleteAction={coupledRow ? deleteCouplingAction.bind(null, coupledRow.l.couplingId!, group.id, stand ?? null) : undefined}
          initial={initial}
          cancelHref={base}
          options={{
            ...options,
            groups: PLANNED_GROUP_KINDS.map((k) => ({
              label: GROUP_KIND_LABELS[k],
              options: groupList.filter((g) => g.kind === k).map((g) => ({ value: g.id, label: g.name })),
            })).filter((g) => g.options.length),
          }}
        />
      </Card>
    );
  } else if (editing || creating) {
    const validity = await defaultValidity(db, today, stand);
    const initial: LessonFormValues = editing
      ? {
          groupId: group.id,
          weekday: editing.l.weekday,
          periodNr: editing.l.periodNr,
          subjectId: editing.l.subjectId,
          teacherId: editing.l.teacherId ?? "",
          roomId: editing.l.roomId ?? "",
          week: editing.l.week,
          validFrom: editing.l.validFrom,
          validUntil: editing.l.validUntil ?? "",
        }
      : {
          groupId: group.id,
          weekday: newDay!,
          periodNr: newPeriod!,
          subjectId: "",
          teacherId: "",
          roomId: "",
          week: "all",
          validFrom: validity.validFrom,
          validUntil: validity.validUntil ?? "",
        };
    form = (
      <Card aria-labelledby="lesson-form-title">
        <h2 id="lesson-form-title" className="text-base font-semibold">
          {editing ? "Stunde bearbeiten" : "Stunde anlegen"} · {group.name}
        </h2>
        {editing && <MoveLink href={`${base}&verschieben=${editing.l.id}`} />}
        {editing && <FixToggle action={toggleFixedAction.bind(null, editing.l.id, group.id, !editing.l.fixed, stand ?? null)} fixed={editing.l.fixed} />}
        <LessonForm
          key={editing?.l.id ?? sp.neu}
          action={saveLessonAction.bind(null, editing?.l.id ?? null)}
          deleteAction={editing ? deleteLessonAction.bind(null, editing.l.id, group.id, stand ?? null) : undefined}
          initial={initial}
          cancelHref={base}
          couplingHref={editing ? `${base}&kopplung=neu&von=${editing.l.id}` : `${base}&kopplung=neu&neu=${sp.neu}`}
          suggestions={Object.fromEntries(master.subjects.map((s) => [s.id, suggestRoom(s, group.homeRoomId, master.rooms) ?? ""]))}
          options={options}
        />
      </Card>
    );
  }

  return (
    <main className="flex flex-col gap-6">
      {header}
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}
      {(stand || periodStarts.length > 0) && (
        <nav aria-label="Planungsstand" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Plan gültig</span>
          <Button asChild size="sm" variant={stand ? "ghost" : "secondary"}>
            <Link href={groupBase} aria-current={stand ? undefined : "page"}>
              heute
            </Link>
          </Button>
          {[...new Set([...periodStarts, ...(stand ? [stand] : [])])].sort().map((d) => (
            <Button key={d} asChild size="sm" variant={d === stand ? "secondary" : "ghost"}>
              <Link href={`${groupBase}&stand=${d}`} aria-current={d === stand ? "page" : undefined}>
                ab {fmtYmd(d)}
              </Link>
            </Button>
          ))}
        </nav>
      )}
      {form}
      <OpenPanel open={open} base={base} placing={placing?.id} />
      {moving && (
        <Card aria-labelledby="move-title" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="move-title" className="text-base font-semibold">
              Verschieben: {moving.subjectName}
              {moving.teacherCode ? ` (${moving.teacherCode})` : ""} · {WEEKDAYS[moving.l.weekday]} {moving.l.periodNr}. Stunde
            </h2>
            <p className="text-sm text-muted">Freie Felder nehmen die Stunde auf, bei einer anderen Stunde der {group.name} wird getauscht. Belegte Felder nennen den Grund.</p>
          </div>
          <Button asChild size="sm">
            <Link href={base}>Fertig</Link>
          </Button>
        </Card>
      )}
      <Table>
        <caption className="sr-only">Stundenplan {group.name}</caption>
        <thead>
          <tr>
            <th className="w-24">Stunde</th>
            {WEEKDAYS.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {master.periods.map((p) => (
            <tr key={p.nr}>
              <td className="align-top whitespace-nowrap">
                <span className="font-semibold">{p.nr}.</span>
                <span className="block text-xs text-muted tabular-nums">
                  {p.startsAt}–{p.endsAt}
                </span>
              </td>
              {WEEKDAYS.map((d, day) => {
                const here = lessons.filter((r) => r.l.weekday === day && r.l.periodNr === p.nr);
                return (
                  <td key={d} className="min-w-36 align-top">
                    <div className="flex flex-col gap-1.5">
                      {here.map((r) => (
                        <Link
                          key={r.l.id}
                          href={r.l.couplingId ? `${base}&kopplung=${r.l.couplingId}` : `${base}&stunde=${r.l.id}`}
                          aria-current={editing?.l.id === r.l.id || (coupledRow && coupledRow.l.couplingId === r.l.couplingId) ? "true" : undefined}
                          className="flex gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 transition hover:border-border-strong aria-[current=true]:border-accent"
                        >
                          <SubjectBar color={r.color} className="h-auto w-1 shrink-0 self-stretch" />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{r.subjectName}</span>
                            <span className="text-xs text-muted">
                              {[r.teacherCode, r.l.roomId].filter(Boolean).join(" · ") || "ohne Lehrkraft/Raum"}
                            </span>
                            {(r.l.week !== "all" || endsEarly(r.l.validUntil) || r.l.couplingId || r.l.fixed) && (
                              <span className="mt-0.5 flex flex-wrap gap-1">
                                {r.l.couplingId && <Badge tone="soft">Kopplung · {coupledGroupLabel([...new Set(partsOf(r.l.couplingId).map((p) => p.groupName))])}</Badge>}
                                {r.l.week !== "all" && <Badge>{r.l.week}-Woche</Badge>}
                                {r.l.fixed && (
                                  <Badge>
                                    <Pin aria-hidden className="size-3" /> fixiert
                                  </Badge>
                                )}
                                {endsEarly(r.l.validUntil) && <Badge tone="warn">bis {fmtYmd(r.l.validUntil!)}</Badge>}
                              </span>
                            )}
                          </span>
                        </Link>
                      ))}
                      {grid ? (
                        <PlacementCell
                          cell={grid.get(`${day}-${p.nr}`)!}
                          slot={`${d} ${p.nr}. Stunde`}
                          action={
                            placing
                              ? placeAssignmentAction.bind(null, placing.id, group.id, stand ?? null, day, p.nr)
                              : moveLessonAction.bind(null, moving!.l.id, group.id, stand ?? null, day, p.nr)
                          }
                          verb={placing ? "Hier setzen" : "Hierher verschieben"}
                        />
                      ) : (
                      <Link
                        href={`${base}&neu=${day}-${p.nr}`}
                        aria-label={`Stunde anlegen: ${d} ${p.nr}. Stunde`}
                        className="flex h-8 items-center justify-center rounded-lg border border-dashed border-border text-muted transition hover:border-border-strong hover:text-ink"
                      >
                        <Plus aria-hidden className="size-4" />
                      </Link>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      {!modeOn && (
        <section aria-labelledby="diag" className="flex flex-col gap-2">
          <h2 id="diag" className="font-semibold">
            Diagnose
          </h2>
          {planFindings.length ? (
            <FindingList findings={planFindings} showCategory linkAssignments={false} />
          ) : (
            <p className="text-sm text-muted">
              Keine {DIAGNOSIS_LABELS.gaps}, kein Fach mehrfach am Tag, alle Räume passen.
            </p>
          )}
          <Link href="/planung/unterricht?ansicht=diagnose" className="text-sm text-accent-ink hover:underline">
            Diagnose der ganzen Schule
          </Link>
        </section>
      )}
    </main>
  );
}

/** Vorschlag für den Stichtag: Beginn des 2. Halbjahres, wenn er noch bevorsteht. */
async function suggestedCutoff(db: Awaited<ReturnType<typeof getDb>>, today: string): Promise<string | undefined> {
  const [y] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  return y?.term2StartsOn && y.term2StartsOn > today ? y.term2StartsOn : undefined;
}

/** Halbjahreswechsel: Stichtag wählen → Vorschau → kopieren. */
async function PeriodCard({ cutoff, error, suggestion, today }: { cutoff?: string; error?: string; suggestion?: string; today: string }) {
  let preview: Awaited<ReturnType<typeof periodPreview>> | null = null;
  let previewError = error ?? null;
  if (cutoff && !error) {
    try {
      preview = await periodPreview(await getDb(), cutoff, today);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      previewError = Object.values(err.fieldErrors)[0] ?? "Datum prüfen";
    }
  }
  return (
    <Card aria-labelledby="period-title">
      <h2 id="period-title" className="text-base font-semibold">
        Neue Periode (Halbjahreswechsel)
      </h2>
      <p className="text-sm text-muted">
        Alle Stunden, die über den Stichtag laufen, enden am Vortag; eine Kopie gilt ab dem Stichtag. Danach lässt sich der Plan ab dem Stichtag ändern, ohne
        Klassenbuch und Vertretungen davor anzufassen.
      </p>
      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Stichtag
          <Input type="date" name="periode" defaultValue={cutoff ?? suggestion ?? ""} required className="w-48" />
        </label>
        <Button type="submit">Vorschau</Button>
      </form>
      {previewError && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {previewError}
        </p>
      )}
      {preview && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4 text-sm">
          <p>
            Ab {fmtYmd(preview.cutoff)}: <strong>{preview.split}</strong> Stunden werden kopiert
            {preview.moved > 0 && `, ${preview.moved} Vertretungen/Klassenbuch-Einträge ab dem Stichtag ziehen mit um`}.
            {preview.alreadyFuture > 0 && ` ${preview.alreadyFuture} Stunden beginnen schon ab dem Stichtag oder später und bleiben, wie sie sind.`}
          </p>
          {preview.split > 0 && (
            <form action={copyPeriodAction.bind(null, preview.cutoff)}>
              <Button type="submit" variant="primary">
                Periode ab {fmtYmd(preview.cutoff)} anlegen
              </Button>
            </form>
          )}
        </div>
      )}
    </Card>
  );
}

/** Stunde für die automatische Planung fixieren bzw. lösen. */
function FixToggle({ action, fixed }: { action: () => Promise<void>; fixed: boolean }) {
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{fixed ? "Fixiert: die automatische Planung lässt die Stunde stehen." : "Nicht fixiert."}</span>
      <Button type="submit" size="sm" variant="ghost">
        <Pin aria-hidden /> {fixed ? "Lösen" : "Fixieren"}
      </Button>
    </form>
  );
}
