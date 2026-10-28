import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pin, Plus, Wand2 } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { toggleFixedAction, deleteCouplingAction, deleteLessonAction, moveLessonAction, placeAssignmentAction, saveCouplingAction, saveLessonAction } from "@/modules/stundenplan/actions";
import { coupledGroupLabel } from "@/modules/stundenplan/display";
import { correctionCount, correctionFrom, correctionSummary, FOLLOW_UP_HINT, type CorrectionSummary } from "@/modules/stundenplan/sofortkorrektur";
import { validVersion, versionNumber } from "@/modules/stundenplan/planversionen";
import { DIAGNOSIS_LABELS, groupPlanFindings } from "@/modules/stundenplan/diagnose";
import { couplingParts, defaultValidity, lessonsOfGroup, plannableGroups, suggestRoom, WEEKDAYS } from "@/modules/stundenplan/manage";
import { loadPickList, teacherSubjectMap } from "@/modules/stundenplan/lehrfaecher";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { assignmentPlacement, movePlacement, moveGridInput, openAssignments, placementGrid, type Cell } from "@/modules/stundenplan/setzhilfe";
import { PLANNED_GROUP_KINDS } from "@/modules/stundenplan/verteilung";
import { yearOfVersion } from "@/modules/stundenplan/planungsjahr";
import { planningYearForPage } from "../planungsjahr";
import { QUELLE_LIVE, quelleQuery, resolveQuelle } from "@/modules/stundenplan/quelle";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Select } from "@schulos/ui/field";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ExportMenu } from "@/ui/export-menu";
import { CouplingForm, type CouplingFormValues } from "./coupling-form";
import { LessonForm, type LessonFormValues } from "./lesson-form";
import { MoveLink, OpenPanel, PlacementCell } from "./setzhilfe-ui";
import { FindingList } from "@/app/(shell)/planung/unterricht/diagnosis";

export const metadata: Metadata = { title: "Stundenplan pflegen" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmtYmd = (ymd: string) => dateFmt.format(new Date(`${ymd}T00:00:00Z`));

type Search = { stand?: string; korrektur?: string; gruppe?: string; neu?: string; stunde?: string; kopplung?: string; von?: string; setzen?: string; verschieben?: string; fehler?: string; quelle?: string; jahr?: string };

export default async function StundenplanPflegePage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  // SP3-09a: Planungsjahr aus dem Kopf des Bereichs; ein Entwurf in der URL kennt sein Jahr (Deeplink stellt um)
  const draftYear = sp.quelle && sp.quelle !== QUELLE_LIVE ? ((await yearOfVersion(db, sp.quelle))?.id ?? null) : null;
  const py = await planningYearForPage(db, "/planung/stundenplan", sp, draftYear);
  const year = py?.year ?? null;
  const [groupList, master, fakultas] = await Promise.all([plannableGroups(db, year?.id), timetableMasterData(db), teacherSubjectMap(db)]);
  const group = groupList.find((g) => g.id === sp.gruppe);
  // SP3-02: Quelle „Gültiger Plan“ oder ein offener Entwurf – im Entwurf ist der Planungsstand sein Stichtag
  let q = await resolveQuelle(db, sp.quelle, year?.id ?? null);
  // SP3-09a: außerhalb des laufenden Schuljahrs gibt es keinen gültigen Plan zum Pflegen – dort nur Entwürfe (Vorgabe: der neueste)
  const liveAllowed = !py || py.isBase;
  if (!liveAllowed && q.value === QUELLE_LIVE) {
    const first = q.options.find((o) => o.value !== QUELLE_LIVE);
    if (first) q = await resolveQuelle(db, first.value, year?.id ?? null);
  }
  const sourceOptions = liveAllowed ? q.options : q.options.filter((o) => o.value !== QUELLE_LIVE);
  const draft = q.version;
  const src = q.source;
  const quelle = q.value === QUELLE_LIVE ? null : q.value;
  const noDraft = !liveAllowed && !draft;
  const readOnly = !q.editable || !(py?.writable ?? true) || noDraft;
  // Planungsstand: heute oder ein künftiger Stichtag (z. B. nach einer Sofort-Korrektur ab dem nächsten Schultag)
  const stand = !draft && sp.stand && /^\d{4}-\d{2}-\d{2}$/.test(sp.stand) && sp.stand > today ? sp.stand : undefined;
  const view = draft ? (draft.validFrom ?? today) : (stand ?? today);
  /** Beginn neuer Stunden: Stichtag des Entwurfs bzw. der Planungsstand */
  const from = draft ? (draft.validFrom ?? undefined) : stand;

  // SP3-05: im gültigen Plan ist jede Änderung eine Sofort-Korrektur ab dem nächsten Schultag (Hinweis, Ergebnis der letzten Aktion, Zähler)
  const correction = !draft && sp.korrektur ? await correctionSummary(db, sp.korrektur) : null;
  const liveFrom = draft ? null : await correctionFrom(db, today);
  const valid = !draft && year ? await validVersion(db, year.id) : null;
  const liveTotal = valid ? await correctionCount(db, valid.id) : 0;
  const liveVersion = valid ? versionNumber(valid) : null;
  const liveNoteText = liveFrom ? `Laufende Stunden ändern sich ab ${fmtYmd(liveFrom)} (bis dahin bleibt alles, wie es war – Klassenbuch und Vertretungen davor bleiben zugeordnet). Betroffene bekommen einen Gong.` : undefined;

  const header = (
    <>
      <PageHeader
        eyebrow="Stundenplanung"
        title="Stundenplan pflegen"
        actions={
          <>
            <ExportMenu arts={["gesamt-klassen", "gesamt-lehrkraefte"]} perms={perms} />
            <Button asChild>
              <Link href={`/planung/solver${quelle ? `?quelle=${encodeURIComponent(quelle)}` : ""}`}>
                <Wand2 aria-hidden /> Automatisch planen
              </Link>
            </Button>
          </>
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
        {sourceOptions.length > (liveAllowed ? 1 : 0) && (
          <Select name="quelle" defaultValue={q.value} aria-label="Plan" className="w-72">
            {sourceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
        {stand && <input type="hidden" name="stand" value={stand} />}
        <Button type="submit">Anzeigen</Button>
      </form>
      {!draft && liveAllowed && <LiveNote correction={correction} from={liveFrom} total={liveTotal} versionLabel={liveVersion} today={today} groupId={group?.id ?? null} />}
      {draft && (
        <p data-testid="entwurf-hinweis" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
          Du arbeitest im <strong>{q.label}</strong>
          {draft.validFrom ? ` ab ${fmtYmd(draft.validFrom)}` : ""}. Änderungen wirken erst mit dem Veröffentlichen – der gültige Plan, Vertretungen und Klassenbuch
          bleiben unverändert.{readOnly ? (py?.writable === false ? " Das Schuljahr ist abgeschlossen – nur lesbar." : " Dieser Entwurf ist nicht mehr bearbeitbar.") : ""}{" "}
          <Link href={`/planung/versionen/aenderungen?version=${encodeURIComponent(draft.id)}`} className="font-medium text-accent-ink hover:underline">
            Änderungen zum gültigen Plan
          </Link>
        </p>
      )}
    </>
  );
  if (noDraft && year) {
    return (
      <main className="flex flex-col gap-6">
        {header}
        {py?.writable ? (
          <EmptyState title={`Noch kein Entwurf für ${year.name}`}>
            Im Folgejahr planst du in einem Entwurf: unter{" "}
            <Link href="/planung/versionen#vorlagen" className="font-medium text-accent-ink underline">
              Planversionen
            </Link>{" "}
            mit der Vorlage „Neues Schuljahr“ anlegen (hochgestuft aus dem Vorjahr oder leer). Klassen gibt es erst nach der Versetzung im{" "}
            <Link href="/verwaltung/schuljahreswechsel" className="font-medium text-accent-ink underline">
              Schuljahreswechsel
            </Link>
            .
          </EmptyState>
        ) : (
          <EmptyState title={`Schuljahr ${year.name} abgeschlossen`}>
            Der Plan bleibt lesbar unter{" "}
            <Link href="/planung/versionen" className="font-medium text-accent-ink underline">
              Planversionen
            </Link>{" "}
            („Plan am Tag X“, Druck).
          </EmptyState>
        )}
      </main>
    );
  }
  if (!group) {
    return (
      <main className="flex flex-col gap-6">
        {header}
        {groupList.length === 0 && py && !py.isBase ? (
          <EmptyState title={`Noch keine Klassen im Schuljahr ${py.year.name}`}>
            Klassen des Folgejahrs entstehen mit der Versetzung im{" "}
            <Link href="/verwaltung/schuljahreswechsel" className="font-medium text-accent-ink underline">
              Schuljahreswechsel
            </Link>{" "}
            (Verwaltung).
          </EmptyState>
        ) : (
          <EmptyState title="Keine Gruppe gewählt">Wähle eine Klasse, einen Kurs oder eine AG, um ihren Stundenplan zu bearbeiten.</EmptyState>
        )}
        {!draft && (
          <Card aria-labelledby="halbjahr-title">
            <h2 id="halbjahr-title" className="text-base font-semibold">
              Halbjahreswechsel
            </h2>
            <p className="text-sm text-muted">
              Der Plan fürs 2. Halbjahr entsteht als Entwurf aus dem gültigen Plan (Vorlage „Neues Halbjahr“ unter{" "}
              <Link href="/planung/versionen" className="font-medium text-accent-ink hover:underline">
                Planversionen
              </Link>
              ) und gilt erst mit dem Veröffentlichen ab dem Stichtag – Klassenbuch und Vertretungen davor bleiben an den bisherigen Stunden.
            </p>
          </Card>
        )}
      </main>
    );
  }

  const upcoming = await lessonsOfGroup(db, group.id, view, src);
  const lessons = upcoming.filter((r) => r.l.validFrom <= view);
  // künftige Perioden der Gruppe (Stunden, die erst später beginnen) – im Entwurf gilt sein Stichtag
  const periodStarts = draft ? [] : [...new Set(upcoming.map((r) => r.l.validFrom).filter((d) => d > today))].sort().slice(0, 4);
  const parts = await couplingParts(db, [...new Set(lessons.map((r) => r.l.couplingId).filter((c): c is string => Boolean(c)))], src);
  const partsOf = (cid: string) => parts.filter((p) => p.couplingId === cid);
  const base = `/planung/stundenplan?gruppe=${encodeURIComponent(group.id)}${stand ? `&stand=${stand}` : ""}${quelleQuery(quelle)}`;
  const groupBase = `/planung/stundenplan?gruppe=${encodeURIComponent(group.id)}`;
  // Setzhilfe: offene Lehraufträge, Freiraster beim Setzen bzw. Verschieben
  const [open, planFindings] = await Promise.all([openAssignments(db, group.id, view, src), groupPlanFindings(db, group.id, view, src)]);
  const placing = !readOnly && sp.setzen ? open.find((a) => a.id === sp.setzen) : undefined;
  const moving = !readOnly && !placing && sp.verschieben ? lessons.find((r) => r.l.id === sp.verschieben) : undefined;
  const gridDims = [WEEKDAYS.map((_, i) => i), master.periods.map((p) => p.nr)] as const;
  let grid: Map<string, Cell> | null = null;
  if (placing) grid = placementGrid({ ...(await assignmentPlacement(db, placing, today, from, src)), unitIds: [], weekdays: [...gridDims[0]], periods: [...gridDims[1]] });
  else if (moving) {
    const m = await movePlacement(db, moving.l.id, src);
    if (m?.unit.length) grid = placementGrid(moveGridInput(m, group.id, [...gridDims[0]], [...gridDims[1]]));
  }
  const modeOn = Boolean(grid);
  const yearEnd = (await defaultValidity(db, today, from)).validUntil;
  const endsEarly = (until: string | null) => until !== null && (yearEnd === null || until < yearEnd);

  const editing = !readOnly && !modeOn && sp.stunde ? lessons.find((r) => r.l.id === sp.stunde && !r.l.couplingId) : undefined;
  const [newDay, newPeriod] = (sp.neu ?? "").split("-").map(Number);
  const creating = !readOnly && !editing && sp.neu !== undefined && Number.isInteger(newDay) && Number.isInteger(newPeriod);
  // SP2-12: Lehrfächer + Restdeputat nur laden, wenn ein Formular offen ist
  const formOpen = Boolean(editing || creating || (sp.kopplung && (sp.kopplung !== "neu" || sp.von || creating)));
  const options = {
    weekdays: WEEKDAYS.map((d, i) => ({ value: String(i), label: d })),
    periods: master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde (${p.startsAt}–${p.endsAt})` })),
    subjects: master.subjects.map((s) => ({ value: s.id, label: s.name })),
    teachers: formOpen ? await loadPickList(db, today, year) : [],
    rooms: master.rooms.map((r) => ({ value: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` })),
  };

  let form: React.ReactNode = null;
  // Kopplung: bestehende bearbeiten, aus einer Einzelstunde erweitern oder neu im Slot anlegen
  const coupledRow = !readOnly && sp.kopplung && sp.kopplung !== "neu" ? lessons.find((r) => r.l.couplingId === sp.kopplung) : undefined;
  const fromLesson = !readOnly && sp.kopplung === "neu" && sp.von ? lessons.find((r) => r.l.id === sp.von && !r.l.couplingId) : undefined;
  if (coupledRow || fromLesson || (sp.kopplung === "neu" && creating)) {
    const validity = await defaultValidity(db, today, from);
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
        {coupledRow && <FixToggle action={toggleFixedAction.bind(null, coupledRow.l.id, group.id, !coupledRow.l.fixed, stand ?? null, quelle)} fixed={coupledRow.l.fixed} />}
        <p className="text-sm text-muted">
          Alle Teile liegen zur selben Zeit: geteilte Klasse (z. B. Religion/Philosophie), Kurse über Klassen hinweg, eine Lehrkraft für mehrere Gruppen oder
          Teamteaching im selben Raum.
        </p>
        <CouplingForm
          key={coupledRow?.l.couplingId ?? `neu-${sp.von ?? sp.neu}`}
          action={saveCouplingAction.bind(null, coupledRow?.l.couplingId ?? null, group.id, quelle)}
          deleteAction={coupledRow ? deleteCouplingAction.bind(null, coupledRow.l.couplingId!, group.id, stand ?? null, quelle) : undefined}
          initial={initial}
          cancelHref={base}
          liveNote={slotOf && slotOf.l.validFrom <= today ? liveNoteText : undefined}
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
    const validity = await defaultValidity(db, today, from);
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
        {editing && <FixToggle action={toggleFixedAction.bind(null, editing.l.id, group.id, !editing.l.fixed, stand ?? null, quelle)} fixed={editing.l.fixed} />}
        <LessonForm
          key={editing?.l.id ?? sp.neu}
          action={saveLessonAction.bind(null, editing?.l.id ?? null, quelle)}
          deleteAction={editing ? deleteLessonAction.bind(null, editing.l.id, group.id, stand ?? null, quelle) : undefined}
          initial={initial}
          cancelHref={base}
          couplingHref={editing ? `${base}&kopplung=neu&von=${editing.l.id}` : `${base}&kopplung=neu&neu=${sp.neu}`}
          liveNote={editing && editing.l.validFrom <= today ? liveNoteText : undefined}
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
      {!readOnly && <OpenPanel open={open} base={base} placing={placing?.id} fakultas={fakultas} />}
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
                              ? placeAssignmentAction.bind(null, placing.id, group.id, stand ?? null, quelle, day, p.nr)
                              : moveLessonAction.bind(null, moving!.l.id, group.id, stand ?? null, quelle, day, p.nr)
                          }
                          verb={placing ? "Hier setzen" : "Hierher verschieben"}
                        />
                      ) : readOnly ? null : (
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
          <Link href={`/planung/unterricht?ansicht=diagnose${quelleQuery(quelle)}`} className="text-sm text-accent-ink hover:underline">
            Diagnose der ganzen Schule{draft ? " (Entwurf)" : ""}
          </Link>
        </section>
      )}
    </main>
  );
}

const KIND_TEXT = { split: "ab dem Stichtag neu", inplace: "direkt geändert", delete: "entfallen", create: "neu angelegt" } as const;

/**
 * SP3-05 (F-10-2): Hinweis im gültigen Plan – Änderungen sind Sofort-Korrekturen ab dem nächsten Schultag; nach einer Aktion ihr Ergebnis
 * (mit Link auf den Plan ab dem Stichtag) und ab `FOLLOW_UP_HINT` geänderten Stunden der Rat, größere Änderungen als Folgeversion zu planen.
 */
function LiveNote({
  correction,
  from,
  total,
  versionLabel,
  today,
  groupId,
}: {
  correction: CorrectionSummary | null;
  from: string | null;
  total: number;
  versionLabel: string | null;
  today: string;
  groupId: string | null;
}) {
  const many = (correction?.suggestFollowUp ?? false) || total >= FOLLOW_UP_HINT;
  const kinds = correction
    ? (Object.entries(correction.kinds) as [keyof typeof KIND_TEXT, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${KIND_TEXT[k]}`)
        .join(", ")
    : "";
  return (
    <div className="flex flex-col gap-2">
      {correction && (
        <p role="status" data-testid="korrektur-ergebnis" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          Sofort-Korrektur {correction.from > today ? `ab ${fmtYmd(correction.from)}` : "gespeichert"}: {correction.lessons === 1 ? "1 Stunde" : `${correction.lessons} Stunden`} ({kinds}). Betroffene
          Lehrkräfte haben einen Gong bekommen, Klassen/Kurse bekommen ihn zur Vortags-Uhrzeit.
          {groupId && correction.from > today && (
            <>
              {" "}
              <Link href={`/planung/stundenplan?gruppe=${encodeURIComponent(groupId)}`} className="font-medium underline">
                Plan heute ansehen
              </Link>
            </>
          )}
        </p>
      )}
      {from && (
        <p data-testid="korrektur-hinweis" className="text-sm text-muted">
          Gültiger Plan{versionLabel ? ` (Version ${versionLabel})` : ""}: Änderungen an laufenden Stunden gelten als Sofort-Korrektur ab {fmtYmd(from)} – die
          Stunde endet am Vortag, ab dann gilt die neue; Klassenbuch, Vertretungen und Material davor bleiben zugeordnet. Stunden, die erst später beginnen
          oder heute neu angelegt sind, ändern sich direkt.
        </p>
      )}
      {many && (
        <p role="note" data-testid="folgeversion-hinweis" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
          {correction?.suggestFollowUp && correction.lessons >= FOLLOW_UP_HINT
            ? `Diese Änderung betrifft ${correction.lessons} Stunden.`
            : `Seit Version ${versionLabel ?? "?"} gilt, wurden ${Math.max(total, correction?.versionTotal ?? 0)} Stunden direkt geändert.`}{" "}
          Größere Änderungen besser als Folgeversion planen – Entwurf aus dem gültigen Plan, Änderungen ansehen, Prüfung und Freigabe, dann veröffentlichen:{" "}
          <Link href="/planung/versionen#vorlagen" className="font-medium text-accent-ink hover:underline">
            Vorlage „Änderung im laufenden Plan“
          </Link>
        </p>
      )}
    </div>
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
