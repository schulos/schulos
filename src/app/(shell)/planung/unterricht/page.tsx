import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, GraduationCap, Plus, Upload, Wand2 } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { periods, REDUCTION_REASONS } from "@/core/db/schema";
import { readSchoolSettings } from "@/core/settings";
import {
  addBandMemberAction,
  addReductionAction,
  deleteAssignmentAction,
  deleteBandAction,
  deleteReductionAction,
  importAssignmentsAction,
  removeBandMemberAction,
  saveAssignmentAction,
  saveBandAction,
  saveObligationAction,
  saveTeacherDayRuleAction,
  saveGradeRulesAction,
  applyGradeRuleDefaultsAction,
  saveTeacherSubjectsAction,
  saveMatrixAction,
} from "@/modules/stundenplan/actions";
import { activeTeacherIds, pickList, teacherSubjectMap } from "@/modules/stundenplan/lehrfaecher";
import { formName } from "@/core/school/catalog";
import { classGrades, listGradeRules } from "@/modules/stundenplan/jahrgangsregeln";
import { dayRuleFor, LUNCH_MIN_MINUTES, ruleSummary } from "@/modules/stundenplan/tagesgrenzen";
import { DIAGNOSIS_CATEGORIES, diagnoseYear, type DiagnosisCategory } from "@/modules/stundenplan/diagnose";
import { defaultObligation, deputyAccounts, REDUCTION_LABELS, reductionKind, type DeputyAccount, type Reduction } from "@/modules/stundenplan/deputate";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { bandMembers, freeAssignments, validityLabel as validityText } from "@/modules/stundenplan/baender-ansicht";
import { distribution, PLANNED_GROUP_KINDS, type Assignment, type Distribution } from "@/modules/stundenplan/verteilung";
import { yearOfVersion } from "@/modules/stundenplan/planungsjahr";
import { planningYearForPage } from "../planungsjahr";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { QUELLE_LIVE, resolveQuelle } from "@/modules/stundenplan/quelle";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ExportMenu } from "@/ui/export-menu";
import { AssignmentForm, type AssignmentFormValues } from "./assignment-form";
import { BandForm, BandMemberForm } from "./band-forms";
import { GradeRulesForm } from "./grade-rules-form";
import { ObligationForm, ReductionForm, TeacherDayRuleForm } from "./deputy-forms";
import { DiagnosisView } from "./diagnosis";
import { TeacherSubjectsForm } from "./teacher-subjects-form";
import { MatrixEditor } from "./matrix";
import { loadMatrix, matrixClasses, matrixGrades, matrixSuggestions, type SuggestionResult } from "@/modules/stundenplan/matrix";
import type { PickTeacher } from "@/modules/stundenplan/lehrfaecher-auswahl";

export const metadata: Metadata = { title: "Unterrichtsverteilung" };

type Search = { jahrgang?: string; vorschlag?: string; ansicht?: string; kategorie?: string; art?: string; gruppe?: string; lehrkraft?: string; neu?: string; auftrag?: string; uebernommen?: string; band?: string; gespeichert?: string; stichtag?: string; quelle?: string; jahr?: string };

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });

function href(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(p).filter((e): e is [string, string] => Boolean(e[1])));
  const s = q.toString();
  return `/planung/unterricht${s ? `?${s}` : ""}`;
}

/** verplant gegen Soll: grün = passt, gelb = offen, rot = zu viel */
function Coverage({ planned, target }: { planned: number; target: number }) {
  const tone = planned === target ? "success" : planned < target ? "warn" : "danger";
  const label = planned === target ? "vollständig verplant" : planned < target ? `${num.format(target - planned)} offen` : `${num.format(planned - target)} zu viel`;
  return (
    <Badge tone={tone} title={label}>
      {num.format(planned)} / {num.format(target)}
      <span className="sr-only"> – {label}</span>
    </Badge>
  );
}

export default async function UnterrichtsverteilungPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  // SP3-09a: Planungsjahr aus dem Kopf des Bereichs (Cookie); ein Entwurf in der URL bzw. `jahr=` stellt es um (Deeplink)
  const draftYear = sp.quelle && sp.quelle !== QUELLE_LIVE ? ((await yearOfVersion(db, sp.quelle))?.id ?? null) : null;
  const py = await planningYearForPage(db, "/planung/unterricht", sp, draftYear);
  const year = py?.year ?? null;
  if (!py || !year) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplanung" title="Unterrichtsverteilung" />
        <EmptyState title="Kein Schuljahr angelegt">Lege unter Stammdaten → Schuljahre zuerst ein Schuljahr an.</EmptyState>
      </main>
    );
  }
  const today = toBerlinDate(new Date());
  /** abgeschlossenes Schuljahr: nur lesbar (die Actions lehnen ebenfalls ab) */
  const ro = !py.writable;
  // SP2-09: Verteilung an einem wählbaren Stichtag (Lehraufträge mit Gültigkeit, z. B. 2. Halbjahr)
  const stichtag = sp.stichtag && /^\d{4}-\d{2}-\d{2}$/.test(sp.stichtag) ? sp.stichtag : undefined;
  // SP3-02: „verplant“, Deputat-Ist und Diagnose wahlweise gegen einen Entwurf (Vorgabe-Stichtag: der des Entwurfs)
  const q = await resolveQuelle(db, sp.quelle, year.id);
  const quelle = q.value === QUELLE_LIVE ? undefined : q.value;
  const ref = stichtag ?? q.version?.validFrom ?? today;
  const [d, master, school, fakultas, active] = await Promise.all([
    distribution(db, year, ref, { source: q.source }),
    timetableMasterData(db),
    readSchoolSettings(db),
    teacherSubjectMap(db),
    activeTeacherIds(db), // R2-P2: nur aktive Lehrkräfte vorschlagen
  ]);
  const fallback = defaultObligation(school.profile.form);
  const accounts = await deputyAccounts(db, year.id, d.teachers, fallback, d.refYmd);
  const subjectOptions = master.subjects.map((s) => ({ value: s.id, label: s.name, color: s.color }));
  const teachersView = sp.ansicht === "lehrkraefte";
  const diagnoseView = sp.ansicht === "diagnose";
  const bandsView = sp.ansicht === "baender";
  const limitsView = sp.ansicht === "tagesgrenzen";
  const matrixView = sp.ansicht === "matrix";
  const otherView = teachersView || diagnoseView || bandsView || limitsView || matrixView;
  const report = diagnoseView ? await diagnoseYear(db, year, ref, fallback, d, { source: q.source }) : null;
  const category = DIAGNOSIS_CATEGORIES.find((c): c is DiagnosisCategory => c === sp.kategorie);
  const group = d.groups.find((g) => g.id === sp.gruppe);
  const teacher = teachersView ? d.teachers.find((t) => t.id === sp.lehrkraft) : undefined;
  // Review R3 N5: auch die Tagesgrenzen-Ansicht bleibt bei Stichtag „Anzeigen“, „Heute“ und „Lehrauftrag anlegen“ erhalten
  const current = { ansicht: teachersView ? "lehrkraefte" : diagnoseView ? "diagnose" : bandsView ? "baender" : limitsView ? "tagesgrenzen" : matrixView ? "matrix" : undefined, jahrgang: matrixView ? sp.jahrgang : undefined, kategorie: diagnoseView ? category : undefined, art: sp.art, gruppe: group?.id, lehrkraft: teacher?.id, stichtag, quelle };
  const back = href(current);

  // ------------------------------------------------------------ Formular
  const editing = !ro && sp.auftrag ? [...d.assignments, ...d.otherTime].find((a) => a.id === sp.auftrag) : undefined;
  let form: React.ReactNode = null;
  if (editing || (!ro && sp.neu !== undefined)) {
    const initial: AssignmentFormValues = {
      groupId: editing?.groups[0]?.id ?? group?.id ?? "",
      bandId: editing?.bandId ?? "",
      subjectId: editing?.subjectId ?? "",
      hours: String(editing?.hours ?? 2),
      doubleLessons: String(editing?.doubleLessons ?? 0),
      teacherId: editing?.teachers[0]?.id ?? teacher?.id ?? "",
      teacher2Id: editing?.teachers[1]?.id ?? "",
      roomId: editing?.roomId ?? "",
      note: editing?.note ?? "",
      validFrom: editing?.validFrom ?? "",
      validUntil: editing?.validUntil ?? "",
    };
    form = (
      <Card aria-labelledby="assignment-form-title">
        <h2 id="assignment-form-title" className="text-base font-semibold">
          {editing ? `Lehrauftrag bearbeiten · ${editing.subjectName}` : "Lehrauftrag anlegen"}
        </h2>
        <AssignmentForm
          key={editing?.id ?? "neu"}
          action={saveAssignmentAction.bind(null, year.id, editing?.id ?? null)}
          deleteAction={editing ? deleteAssignmentAction.bind(null, editing.id, back) : undefined}
          initial={initial}
          back={back}
          year={year}
          options={{
            groups: PLANNED_GROUP_KINDS.map((k) => ({
              label: GROUP_KIND_LABELS[k],
              options: d.groups.filter((g) => g.kind === k).map((g) => ({ value: g.id, label: g.name })),
            })).filter((g) => g.options.length),
            subjects: master.subjects.map((s) => ({ value: s.id, label: s.name })),
            // SP2-12: Lehrfächer + Restdeputat (Soll − Lehraufträge) für die Vorschläge passend zum Fach
            teachers: pickList(accounts, fakultas, active),
            rooms: master.rooms.map((r) => ({ value: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` })),
            bands: d.bands.map((b) => ({ value: b.id, label: b.name, hours: b.hours, doubleLessons: b.doubleLessons })),
          }}
        />
      </Card>
    );
  }

  // „Aus Stundenplan übernehmen“ liest den gültigen Plan – im Entwurf und außerhalb des laufenden Schuljahrs ausgeblendet
  const unmatchedCount = q.version || !py.isBase ? 0 : d.unmatched.length;
  // SP3-09a: im Folgejahr gibt es Klassen erst nach der Versetzung (Schuljahreswechsel)
  const noClasses = !d.groups.some((g) => g.kind === "klasse");
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Stundenplanung"
        title="Unterrichtsverteilung"
        actions={
          <>
            {/* SP3-09b: Druck/CSV im gewählten Schuljahr und Entwurf */}
            <ExportMenu arts={["verteilung", "deputate"]} perms={perms} jahr={py.isBase ? null : year.id} quelle={q.version ? q.value : null} />
            {unmatchedCount > 0 && (
              <form action={importAssignmentsAction.bind(null, year.id)}>
                <Button type="submit">
                  <Wand2 aria-hidden /> Aus Stundenplan übernehmen ({unmatchedCount} Std.)
                </Button>
              </form>
            )}
            {!ro && (
              <>
                <Button asChild>
                  <Link href="/planung/unterricht/import">
                    <Upload aria-hidden /> CSV-Import
                  </Link>
                </Button>
                <Button asChild variant="primary">
                  <Link href={href({ ...current, neu: "1" })}>
                    <Plus aria-hidden /> Lehrauftrag anlegen
                  </Link>
                </Button>
              </>
            )}
          </>
        }
      />
      <p className="-mt-3 text-sm text-muted">
        Schuljahr {year.name} · Lehraufträge und „verplant“ (Stunden {q.version ? `im ${q.label}` : "im Stundenplan"}, A-/B-Wochen halb) am {dateFmt.format(new Date(`${d.refYmd}T00:00:00Z`))}
        {d.otherTime.length > 0 && ` · ${d.otherTime.length} ${d.otherTime.length === 1 ? "Lehrauftrag gilt" : "Lehraufträge gelten"} an diesem Tag nicht`}
      </p>
      <form method="get" aria-label="Stichtag wählen" className="-mt-3 flex flex-wrap items-end gap-2">
        {Object.entries(current)
          .filter((e): e is [string, string] => Boolean(e[1]) && e[0] !== "stichtag" && e[0] !== "quelle")
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Stichtag</span>
          <Input type="date" name="stichtag" min={year.startsOn} max={year.endsOn} defaultValue={d.refYmd} />
        </label>
        {q.options.length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Plan</span>
            <Select name="quelle" defaultValue={q.value} className="w-72">
              {q.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Button type="submit" size="sm">
          Anzeigen
        </Button>
        {stichtag && (
          <Button asChild size="sm" variant="ghost">
            <Link href={href({ ...current, stichtag: undefined })}>Heute</Link>
          </Button>
        )}
      </form>
      {ro && (
        <p role="note" data-testid="nur-lesbar" className="rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-sm">
          Das Schuljahr {year.name} ist abgeschlossen – Lehraufträge, Matrix, Bänder und Deputate sind nur lesbar.
        </p>
      )}
      {noClasses && !py.isBase && <NoClassesNote yearName={year.name} />}
      {sp.uebernommen !== undefined && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {sp.uebernommen === "0" ? "Alle Stunden des Stundenplans haben schon einen Lehrauftrag." : `${sp.uebernommen} Lehraufträge aus dem Stundenplan übernommen.`}
        </p>
      )}
      <nav aria-label="Ansicht" className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant={otherView ? "ghost" : "secondary"}>
          <Link href={href({ stichtag, quelle })} aria-current={otherView ? undefined : "page"}>
            Klassen & Kurse
          </Link>
        </Button>
        <Button asChild size="sm" variant={matrixView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "matrix", stichtag, quelle })} aria-current={matrixView ? "page" : undefined}>
            Matrix
          </Link>
        </Button>
        <Button asChild size="sm" variant={teachersView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "lehrkraefte", stichtag, quelle })} aria-current={teachersView ? "page" : undefined}>
            Lehrkräfte
          </Link>
        </Button>
        <Button asChild size="sm" variant={bandsView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "baender", stichtag, quelle })} aria-current={bandsView ? "page" : undefined}>
            Bänder
          </Link>
        </Button>
        <Button asChild size="sm" variant={limitsView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "tagesgrenzen", stichtag, quelle })} aria-current={limitsView ? "page" : undefined}>
            Tagesgrenzen
          </Link>
        </Button>
        <Button asChild size="sm" variant={diagnoseView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "diagnose", stichtag, quelle })} aria-current={diagnoseView ? "page" : undefined}>
            Diagnose
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/planung/zeitwuensche">Zeitwünsche</Link>
        </Button>
      </nav>
      {form}
      {matrixView ? (
        <MatrixView d={d} year={year} accounts={accounts} teachers={pickList(accounts, fakultas, active)} gradeParam={sp.jahrgang} vorschlag={sp.vorschlag} stichtag={stichtag} readOnly={ro} />
      ) : limitsView ? (
        <LimitsView saved={sp.gespeichert} />
      ) : bandsView ? (
        <BandsView d={d} bandParam={sp.band} yearId={year.id} readOnly={ro} />
      ) : report ? (
        <DiagnosisView report={report} category={category} refLabel={`Stand ${dateFmt.format(new Date(`${d.refYmd}T00:00:00Z`))}`} />
      ) : group ? (
        <GroupDetail d={d} groupId={group.id} current={current} />
      ) : teacher ? (
        <TeacherDetail d={d} year={year} account={accounts.find((a) => a.id === teacher.id)!} fallback={fallback} current={current} subjects={subjectOptions} selected={fakultas.get(teacher.id) ?? []} readOnly={ro} />
      ) : teachersView ? (
        <TeacherOverview accounts={accounts} fakultas={fakultas} />
      ) : (
        <GroupOverview d={d} art={sp.art} stichtag={stichtag} quelle={quelle} />
      )}
    </main>
  );
}

type Current = Record<string, string | undefined>;

/** SP3-09a: Leerzustand im Folgejahr – Klassen entstehen mit der Versetzung im Schuljahreswechsel. */
function NoClassesNote({ yearName }: { yearName: string }) {
  return (
    <p role="note" data-testid="folgejahr-ohne-klassen" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
      Im Schuljahr {yearName} gibt es noch keine Klassen. Sie entstehen mit der Versetzung im{" "}
      <Link href="/verwaltung/schuljahreswechsel" className="font-medium underline">
        Schuljahreswechsel
      </Link>{" "}
      (Verwaltung) bzw. werden dort angelegt. Lehraufträge für Kurse und AGs ohne Schuljahr gehen schon jetzt; die Matrix füllt sich, sobald es Klassen gibt –
      danach „Aus dem Vorjahr übernehmen“.
    </p>
  );
}

function GroupOverview({ d, art, stichtag, quelle }: { d: Distribution; art?: string; stichtag?: string; quelle?: string }) {
  const kinds = PLANNED_GROUP_KINDS.filter((k) => d.groups.some((g) => g.kind === k));
  const kind = kinds.find((k) => k === art) ?? "klasse";
  const list = d.groups.filter((g) => g.kind === kind);
  return (
    <section aria-labelledby="ov" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ov" className="font-display text-xl font-bold">
          Soll und verplant je {GROUP_KIND_LABELS[kind]}
        </h2>
        <div className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <Button key={k} asChild size="sm" variant={k === kind ? "secondary" : "ghost"}>
              <Link href={href({ art: k, stichtag, quelle })} aria-current={k === kind ? "page" : undefined}>
                {GROUP_KIND_LABELS[k]}
              </Link>
            </Button>
          ))}
        </div>
      </div>
      <Table>
        <thead>
          <tr>
            <th>{GROUP_KIND_LABELS[kind]}</th>
            {kind === "klasse" && <th className="text-right">Stundentafel</th>}
            <th className="text-right">Lehraufträge</th>
            <th className="text-right">verplant</th>
          </tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr key={g.id}>
              <td>
                <Link href={href({ art: kind === "klasse" ? undefined : kind, gruppe: g.id, stichtag, quelle })} className="font-medium hover:underline">
                  {g.name}
                </Link>
              </td>
              {kind === "klasse" && <td className="text-right tabular-nums">{g.curriculum === null ? "–" : num.format(g.curriculum)}</td>}
              <td className="text-right tabular-nums">
                {g.curriculum !== null && g.curriculum !== g.assigned ? <Coverage planned={g.assigned} target={g.curriculum} /> : num.format(g.assigned)}
              </td>
              <td className="text-right">
                <Coverage planned={g.planned} target={g.assigned} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

/** Lehraufträge gegen Deputat-Soll: grün = ausgeglichen, gelb = Unterdeckung, rot = Überhang */
function Balance({ balance }: { balance: number }) {
  const tone = balance === 0 ? "success" : balance < 0 ? "warn" : "danger";
  const label = balance === 0 ? "ausgeglichen" : balance < 0 ? `${num.format(-balance)} unter Soll` : `${num.format(balance)} über Soll`;
  return (
    <Badge tone={tone} title={label}>
      {balance > 0 ? "+" : balance < 0 ? "−" : "±"}
      {num.format(Math.abs(balance))}
      <span className="sr-only"> – {label}</span>
    </Badge>
  );
}

function TeacherOverview({ accounts, fakultas }: { accounts: DeputyAccount[]; fakultas: Map<string, string[]> }) {
  const without = accounts.filter((t) => !fakultas.get(t.id)?.length).length;
  return (
    <section aria-labelledby="ov" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ov" className="font-display text-xl font-bold">
          Deputatskonto je Lehrkraft
        </h2>
        <Button asChild size="sm">
          <Link href="/planung/unterricht/lehrfaecher">
            <GraduationCap aria-hidden /> Lehrfächer importieren (CSV)
          </Link>
        </Button>
      </div>
      {without > 0 && (
        <p role="note" className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          {without === 1 ? "1 Lehrkraft hat" : `${without} Lehrkräfte haben`} noch keine Lehrfächer – bei der Zuweisung erscheinen sie nur unter „alle anzeigen“, und im
          Fachbedarf zählt ihr Deputat nicht. Lehrfächer in der Zeile der Lehrkraft oder per CSV pflegen.
        </p>
      )}
      <Table>
        <thead>
          <tr>
            <th>Lehrkraft</th>
            <th className="text-right">Soll</th>
            <th className="text-right">Lehraufträge</th>
            <th className="text-right">Saldo</th>
            <th className="text-right">verplant</th>
            <th>Lehrfächer</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((t) => (
            <tr key={t.id}>
              <td>
                <Link href={href({ ansicht: "lehrkraefte", lehrkraft: t.id })} className="font-medium hover:underline">
                  {t.code ?? "–"}
                </Link>
                <span className="text-muted"> · {t.name}</span>
              </td>
              <td className="text-right tabular-nums">
                {num.format(t.target)}
                {t.target !== t.obligation && <span className="block text-xs text-muted">von {num.format(t.obligation)}</span>}
                {/* SP3-DEP: anderes Halbjahr, wenn es abweicht */}
                {t.terms
                  ?.filter((x) => x.term !== t.term)
                  .map((x) => (
                    <span key={x.term} className="block text-xs text-muted">
                      {x.term}. Hj: {num.format(x.target)}
                    </span>
                  ))}
              </td>
              <td className="text-right tabular-nums">{num.format(t.assigned)}</td>
              <td className="text-right">
                <Balance balance={t.balance} />
              </td>
              <td className="text-right">
                <Coverage planned={t.planned} target={t.assigned} />
              </td>
              <td>{fakultas.get(t.id)?.length ? <span className="text-sm">{fakultas.get(t.id)!.join(", ")}</span> : <Badge tone="warn">keine gepflegt</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function AssignmentTable({ rows, bands, current, caption, show }: { rows: Distribution["assignments"]; bands: Distribution["bands"]; current: Current; caption: string; show: "teachers" | "groups" }) {
  if (!rows.length) return <EmptyState title="Noch keine Lehraufträge" />;
  const bandName = new Map(bands.map((b) => [b.id, b.name]));
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th>Fach</th>
          <th>{show === "teachers" ? "Lehrkraft" : "Klasse/Kurs"}</th>
          <th className="text-right">Std.</th>
          <th>Hinweise</th>
          <th className="text-right">verplant</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id} aria-current={current.auftrag === a.id ? "true" : undefined}>
            <td>
              <Link href={href({ ...current, auftrag: a.id })} className="flex items-center gap-2 font-medium hover:underline">
                <SubjectBar color={a.color} className="h-5 w-1 shrink-0" />
                {a.subjectName}
              </Link>
            </td>
            <td>
              {show === "teachers"
                ? a.teachers.map((t) => t.code ?? t.name).join(" + ") || <Badge tone="warn">offen</Badge>
                : a.groups.map((g) => g.name).join(" + ")}
            </td>
            <td className="text-right tabular-nums">{a.hours}</td>
            <td>
              <span className="flex flex-wrap gap-1">
                {a.bandId && bandName.get(a.bandId) && (
                  <Link href={href({ ansicht: "baender", band: a.bandId })} className="hover:underline">
                    <Badge>Band: {bandName.get(a.bandId)}</Badge>
                  </Link>
                )}
                {show === "groups" && a.teachers.length > 1 && <Badge>Team: {a.teachers.map((t) => t.code).join(" + ")}</Badge>}
                {(a.validFrom || a.validUntil) && <Badge tone="soft">{validityLabel(a)}</Badge>}
                {a.doubleLessons > 0 && <Badge>{a.doubleLessons}× Doppelstunde</Badge>}
                {a.roomId && <Badge>Raum {a.roomId}</Badge>}
                {a.otherTeacher && <Badge tone="warn">andere Lehrkraft im Plan</Badge>}
                {a.note && <span className="text-sm text-muted">{a.note}</span>}
              </span>
            </td>
            <td className="text-right">
              <Coverage planned={a.planned} target={a.hours} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const fmtYmd = (ymd: string) => shortDate.format(new Date(`${ymd}T00:00:00Z`));

/** SP2-09: „ab 01.02.2027“, „bis 31.01.2027“ bzw. „01.02.2027–30.04.2027“ */
function validityLabel(a: Pick<Assignment, "validFrom" | "validUntil">): string {
  if (a.validFrom && a.validUntil) return `${fmtYmd(a.validFrom)}–${fmtYmd(a.validUntil)}`;
  return a.validFrom ? `ab ${fmtYmd(a.validFrom)}` : `bis ${fmtYmd(a.validUntil!)}`;
}

/** SP2-09: Lehraufträge der Gruppe, die am Stichtag nicht gelten – zählen dort nirgends mit. */
function OtherTime({ rows, current }: { rows: Assignment[]; current: Current }) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="ot" className="flex flex-col gap-2">
      <h3 id="ot" className="font-semibold">
        Zu anderer Zeit gültig
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2">
            <Link href={href({ ...current, auftrag: a.id })} className="font-medium hover:underline">
              {a.subjectName}
            </Link>
            <span className="text-muted">
              {a.teachers.map((t) => t.code ?? t.name).join(" + ") || "offen"} · {a.hours} Std.
            </span>
            <Badge tone="soft">{validityLabel(a)}</Badge>
            <Link href={href({ ...current, stichtag: a.validFrom ?? a.validUntil ?? undefined })} className="text-accent-ink hover:underline">
              am {fmtYmd(a.validFrom ?? a.validUntil!)} ansehen
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Unmatched({ rows }: { rows: Distribution["unmatched"] }) {
  if (!rows.length) return null;
  const buckets = new Map<string, { label: string; hours: number }>();
  for (const l of rows) {
    const key = `${l.groupId}|${l.subjectId}|${l.teacherId}`;
    const b = buckets.get(key) ?? { label: `${l.groupName} · ${l.subjectName} · ${l.teacherCode ?? "ohne Lehrkraft"}`, hours: 0 };
    b.hours += l.weight;
    buckets.set(key, b);
  }
  return (
    <section aria-labelledby="um" className="flex flex-col gap-2">
      <h3 id="um" className="font-semibold">
        Stunden im Plan ohne Lehrauftrag
      </h3>
      <ul className="flex flex-col gap-1 text-sm">
        {[...buckets.values()].map((b) => (
          <li key={b.label}>
            <Badge tone="warn">{num.format(b.hours)} Std.</Badge> {b.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link href={to} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft aria-hidden className="size-4" /> {label}
    </Link>
  );
}

function GroupDetail({ d, groupId, current }: { d: Distribution; groupId: string; current: Current }) {
  const g = d.groups.find((x) => x.id === groupId)!;
  const rows = d.assignments.filter((a) => a.groups.some((x) => x.id === groupId));
  // Stundentafel-Abgleich (Klassen): Fächer, deren Lehraufträge von der Stundentafel abweichen
  const tafel = g.kind === "klasse" && g.gradeLevel !== null ? d.curriculum.get(g.gradeLevel) : undefined;
  const bySubject = new Map<string, { name: string; assigned: number }>();
  for (const a of rows) bySubject.set(a.subjectId, { name: a.subjectName, assigned: (bySubject.get(a.subjectId)?.assigned ?? 0) + a.hours });
  const diffs = tafel
    ? [...new Set([...tafel.keys(), ...bySubject.keys()])]
        .map((s) => ({ id: s, name: d.subjectNames.get(s) ?? s, soll: tafel.get(s) ?? 0, assigned: bySubject.get(s)?.assigned ?? 0 }))
        .filter((x) => x.soll !== x.assigned)
    : [];
  return (
    <section aria-labelledby="gd" className="flex flex-col gap-4">
      <BackLink to={href({ art: current.art, stichtag: current.stichtag, quelle: current.quelle })} label="Alle Gruppen" />
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="gd" className="font-display text-xl font-bold">
          {g.name}
        </h2>
        {g.homeRoomId && <Badge>Stammraum {g.homeRoomId}</Badge>}
        {g.curriculum !== null && <Badge>Stundentafel {num.format(g.curriculum)}</Badge>}
        <Badge>Lehraufträge {num.format(g.assigned)}</Badge>
        <Coverage planned={g.planned} target={g.assigned} />
      </div>
      <AssignmentTable rows={rows} bands={d.bands} current={current} caption={`Lehraufträge ${g.name}`} show="teachers" />
      <OtherTime rows={d.otherTime.filter((a) => a.groups.some((x) => x.id === groupId))} current={current} />
      {tafel && (
        <section aria-labelledby="st" className="flex flex-col gap-2">
          <h3 id="st" className="font-semibold">
            Abgleich mit der Stundentafel
          </h3>
          {diffs.length === 0 ? (
            <p className="text-sm text-muted">Die Lehraufträge entsprechen der Stundentafel.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {diffs.map((x) => (
                <li key={x.id}>
                  <Coverage planned={x.assigned} target={x.soll} /> {x.name}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Unmatched rows={d.unmatched.filter((l) => l.groupId === groupId)} />
    </section>
  );
}

type DeputyYear = { id: string; startsOn: string; endsOn: string; term2StartsOn: string | null };

const ymdDe = (ymd: string) => dateFmt.format(new Date(`${ymd}T00:00:00Z`));

/** SP3-DEP: Gültigkeit einer Ermäßigung/Anrechnung, kurz */
function reductionValidity(r: Reduction): string {
  if (!r.validFrom && !r.validUntil) return "ganzes Schuljahr";
  if (r.validFrom && r.validUntil) return `${ymdDe(r.validFrom)} – ${ymdDe(r.validUntil)}`;
  return r.validFrom ? `ab ${ymdDe(r.validFrom)}` : `bis ${ymdDe(r.validUntil!)}`;
}

function DeputyCard({ account: a, fallback, year, refYmd, readOnly }: { account: DeputyAccount; fallback: number; year: DeputyYear; refYmd: string; readOnly: boolean }) {
  const reductionSum = a.reductions.reduce((s, r) => s + r.hours, 0);
  const all = [...a.reductions.map((r) => ({ r, active: true })), ...a.otherReductions.map((r) => ({ r, active: false }))];
  const term2From = year.term2StartsOn && year.term2StartsOn > year.startsOn && year.term2StartsOn <= year.endsOn ? year.term2StartsOn : null;
  return (
    <Card aria-labelledby="dep" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="dep" className="text-base font-semibold">
          Deputat
        </h3>
        <p className="text-sm text-muted">
          Am {ymdDe(refYmd)}
          {term2From && ` (${a.term}. Halbjahr)`}: Pflicht {num.format(a.obligation)}
          {a.isDefault && " (Vorgabe)"}
          {a.settings.employmentPercent !== null && ` · Teilzeit ${num.format(a.settings.employmentPercent)} %`} − Ermäßigungen/Anrechnungen {num.format(reductionSum)} ={" "}
          <strong className="text-ink">Soll {num.format(a.target)}</strong> · Lehraufträge {num.format(a.assigned)} · Saldo <Balance balance={a.balance} />
        </p>
      </div>
      {/* SP3-DEP: beide Halbjahre, wenn Pflicht oder Soll sich unterscheiden */}
      {a.terms && (
        <Table scrollLabel="Deputat je Halbjahr (Tabelle)">
          <caption className="sr-only">Deputat je Halbjahr</caption>
          <thead>
            <tr>
              <th>Halbjahr</th>
              <th>Zeitraum</th>
              <th className="text-right">Pflicht</th>
              <th className="text-right">Soll am Halbjahresbeginn</th>
            </tr>
          </thead>
          <tbody>
            {a.terms.map((t) => (
              <tr key={t.term} aria-current={t.term === a.term ? "true" : undefined}>
                <td>
                  {t.term}. Halbjahr {t.term === a.term && <Badge tone="accent">Stichtag</Badge>}
                </td>
                <td className="text-muted">
                  {ymdDe(t.from)} – {ymdDe(t.until)}
                </td>
                <td className="text-right tabular-nums">{num.format(t.obligation)}</td>
                <td className="text-right tabular-nums">{num.format(t.target)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {!readOnly && (
        <ObligationForm
          key={`${year.id}|${a.id}`}
          action={saveObligationAction.bind(null, year.id, a.id)}
          value={a.settings.obligation === null ? "" : num.format(a.settings.obligation)}
          percent={a.settings.employmentPercent === null ? "" : num.format(a.settings.employmentPercent)}
          term2={a.settings.obligationTerm2 === null ? "" : num.format(a.settings.obligationTerm2)}
          term2From={term2From ? ymdDe(term2From) : null}
          fallback={fallback}
        />
      )}
      {/* SP2-04: Tagesregel (hart im Solver und in der Setzhilfe, geprüft in der Diagnose) */}
      {!readOnly && (
        <TeacherDayRuleForm
          key={`regel|${year.id}|${a.id}`}
          action={saveTeacherDayRuleAction.bind(null, year.id, a.id)}
          maxPerDay={a.dayRule?.maxPerDay?.toString() ?? ""}
          maxDays={a.dayRule?.maxDays?.toString() ?? ""}
        />
      )}
      {all.length > 0 && (
        <Table scrollLabel="Ermäßigungen und Anrechnungen (Tabelle)">
          <caption className="sr-only">Ermäßigungen und Anrechnungen</caption>
          <thead>
            <tr>
              <th>Grund</th>
              <th>Art</th>
              <th>gültig</th>
              <th className="text-right">Stunden</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {all.map(({ r, active }) => (
              <tr key={r.id} className={active ? undefined : "text-muted"}>
                <td>
                  {REDUCTION_LABELS[r.reason]}
                  {r.note && <span className="text-muted"> · {r.note}</span>}
                </td>
                <td className="text-muted">{reductionKind(r.reason)}</td>
                <td>
                  {reductionValidity(r)}
                  {!active && (
                    <>
                      {" "}
                      <Badge>gilt am Stichtag nicht</Badge>
                    </>
                  )}
                </td>
                <td className="text-right tabular-nums">{num.format(r.hours)}</td>
                <td className="text-right">
                  {!readOnly && (
                    <form action={deleteReductionAction.bind(null, r.id, a.id)}>
                      <Button type="submit" size="sm" variant="ghost" aria-label={`${REDUCTION_LABELS[r.reason]} entfernen`}>
                        Entfernen
                      </Button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {!readOnly && (
        <ReductionForm
          key={`erm|${year.id}|${a.id}`}
          action={addReductionAction.bind(null, year.id, a.id)}
          reasons={REDUCTION_REASONS.map((r) => ({ value: r, label: `${REDUCTION_LABELS[r]} (${reductionKind(r)})` }))}
          min={year.startsOn}
          max={year.endsOn}
          term2From={term2From ? ymdDe(term2From) : null}
        />
      )}
    </Card>
  );
}

function TeacherDetail({
  d,
  year,
  account,
  fallback,
  current,
  subjects,
  selected,
  readOnly,
}: {
  d: Distribution;
  year: DeputyYear;
  account: DeputyAccount;
  fallback: number;
  current: Current;
  subjects: { value: string; label: string; color: string }[];
  selected: string[];
  readOnly: boolean;
}) {
  const t = account;
  const teacherId = t.id;
  const rows = d.assignments.filter((a) => a.teachers.some((x) => x.id === teacherId));
  return (
    <section aria-labelledby="td" className="flex flex-col gap-4">
      <BackLink to={href({ ansicht: "lehrkraefte" })} label="Alle Lehrkräfte" />
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="td" className="font-display text-xl font-bold">
          {t.code} · {t.name}
        </h2>
        <Badge>Soll {num.format(t.target)}</Badge>
        <Badge>Lehraufträge {num.format(t.assigned)}</Badge>
        <Coverage planned={t.planned} target={t.assigned} />
      </div>
      {/* SP2-12: Lehrfächer (Fakultas) – Stammdatum der Lehrkraft für Zuweisung und Fachbedarf */}
      <Card aria-labelledby="fak" className="flex flex-col gap-3">
        <h3 id="fak" className="text-base font-semibold">
          Lehrfächer
        </h3>
        <TeacherSubjectsForm action={saveTeacherSubjectsAction.bind(null, t.id)} subjects={subjects} selected={selected} />
      </Card>
      <DeputyCard account={account} fallback={fallback} year={year} refYmd={d.refYmd} readOnly={readOnly} />
      <AssignmentTable rows={rows} bands={d.bands} current={current} caption={`Lehraufträge ${t.name}`} show="groups" />
      <Unmatched rows={d.unmatched.filter((l) => l.teacherId === teacherId)} />
    </section>
  );
}

/** Kurzbezeichnung eines Lehrauftrags: „7a · Religion · RIC“ */
function assignmentLabel(a: Assignment): string {
  return `${a.groups.map((g) => g.name).join(" + ") || "ohne Gruppe"} · ${a.subjectName} · ${a.teachers.map((t) => t.code ?? t.name).join(" + ") || "offen"}`;
}

/**
 * SP2-01: Bänder – Lehraufträge, die zur selben Zeit liegen. Soll = Wochenstunden des Bands, verplant = das am wenigsten verplante
 * Mitglied, dazu „zur selben Zeit“ = Stunden, in denen alle Mitglieder im selben Slot liegen.
 */
function BandsView({ d, bandParam, yearId, readOnly }: { d: Distribution; bandParam?: string; yearId: string; readOnly: boolean }) {
  const editing = readOnly ? undefined : d.bands.find((b) => b.id === bandParam);
  const creating = !readOnly && bandParam === "neu";
  // Review R3 N4: Mitglieder und „frei“ über alle Zeiträume, nicht nur die am Stichtag gültigen Lehraufträge
  const all: Assignment[] = [...d.assignments, ...d.otherTime];
  const plannedOf = new Map(d.assignments.map((a) => [a.id, a.planned]));
  const back = href({ ansicht: "baender" });
  let form: React.ReactNode = null;
  if (editing || creating) {
    const members = editing ? bandMembers(editing.id, all, d.refYmd) : [];
    const free = freeAssignments(all);
    const groupNames = [...new Set(free.map((a) => a.groups[0]?.name ?? "ohne Gruppe"))];
    form = (
      <Card aria-labelledby="band-form-title" className="flex flex-col gap-4">
        <h3 id="band-form-title" className="text-base font-semibold">
          {editing ? `Band bearbeiten · ${editing.name}` : "Band anlegen"}
        </h3>
        <BandForm
          key={editing?.id ?? "neu"}
          action={saveBandAction.bind(null, yearId, editing?.id ?? null)}
          deleteAction={editing && members.length === 0 ? deleteBandAction.bind(null, editing.id) : undefined}
          initial={{ name: editing?.name ?? "", hours: String(editing?.hours ?? 2), doubleLessons: String(editing?.doubleLessons ?? 0) }}
          back={back}
        />
        {editing && (
          <section aria-labelledby="band-members" className="flex flex-col gap-3">
            <h4 id="band-members" className="font-semibold">
              Lehraufträge im Band
            </h4>
            {members.length === 0 ? (
              <p className="text-sm text-muted">Noch keine – unten einen Lehrauftrag aufnehmen oder im Lehrauftrag das Band wählen.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {members.map(({ assignment: a, active }) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <SubjectBar color={a.color} className="h-5 w-1 shrink-0" />
                    <Link href={href({ gruppe: a.groups[0]?.id, auftrag: a.id })} className="font-medium hover:underline">
                      {assignmentLabel(a)}
                    </Link>
                    {validityText(a) && <Badge tone={active ? "neutral" : "warn"}>{`${validityText(a)}${active ? "" : " · gilt am Stichtag nicht"}`}</Badge>}
                    {active && <Coverage planned={plannedOf.get(a.id) ?? 0} target={a.hours} />}
                    <form action={removeBandMemberAction.bind(null, editing.id, a.id)} className="ml-auto">
                      <Button type="submit" size="sm" variant="ghost" aria-label={`${assignmentLabel(a)} aus dem Band nehmen`}>
                        Aus dem Band nehmen
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {members.length > 0 && <p className="text-sm text-muted">Zum Löschen des Bands erst alle Lehraufträge herausnehmen – auch die aus anderen Zeiträumen.</p>}
            {free.length > 0 && (
              <BandMemberForm
                action={addBandMemberAction.bind(null, editing.id)}
                options={groupNames.map((name) => ({
                  label: name,
                  options: free.filter((a) => (a.groups[0]?.name ?? "ohne Gruppe") === name).map((a) => ({ value: a.id, label: validityText(a) ? `${assignmentLabel(a)} (${validityText(a)})` : assignmentLabel(a) })),
                }))}
              />
            )}
          </section>
        )}
      </Card>
    );
  }
  return (
    <section aria-labelledby="bands" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="bands" className="font-display text-xl font-bold">
          Bänder
        </h2>
        {!readOnly && (
          <Button asChild>
            <Link href={href({ ansicht: "baender", band: "neu" })}>
              <Plus aria-hidden /> Band anlegen
            </Link>
          </Button>
        )}
      </div>
      <p className="-mt-2 text-sm text-muted">
        Ein Band bündelt Lehraufträge, die zur selben Zeit liegen: Religion/Philosophie, Wahlpflicht, E-/G-Kurse, Oberstufen-Schienen oder eine Lehrkraft für mehrere
        Gruppen. Wochen- und Doppelstunden gelten für alle Lehraufträge im Band.
      </p>
      {form}
      {d.bands.length === 0 ? (
        <EmptyState title="Noch keine Bänder" />
      ) : (
        <Table>
          <caption className="sr-only">Bänder mit Soll und verplant</caption>
          <thead>
            <tr>
              <th>Band</th>
              <th>Lehraufträge</th>
              <th className="text-right">Std.</th>
              <th>Hinweise</th>
              <th className="text-right">verplant</th>
            </tr>
          </thead>
          <tbody>
            {d.bands.map((b) => {
              const bandAll = bandMembers(b.id, all, d.refYmd);
              return (
              <tr key={b.id} aria-current={editing?.id === b.id ? "true" : undefined}>
                <td>
                  <Link href={href({ ansicht: "baender", band: b.id })} className="font-medium hover:underline">
                    {b.name}
                  </Link>
                </td>
                <td>
                  {bandAll.length === 0 ? (
                    <Badge tone="warn">leer</Badge>
                  ) : (
                    <ul className="flex flex-col gap-0.5 text-sm">
                      {bandAll.map(({ assignment: a, active }) => (
                        <li key={a.id} className={active ? undefined : "text-muted"}>
                          {assignmentLabel(a)}
                          {validityText(a) && ` (${validityText(a)})`}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="text-right tabular-nums">{b.hours}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    {b.doubleLessons > 0 && <Badge>{b.doubleLessons}× Doppelstunde</Badge>}
                    {b.memberIds.length > 1 && b.together < b.planned && <Badge tone="warn">nur {num.format(b.together)} Std. zur selben Zeit</Badge>}
                  </span>
                </td>
                <td className="text-right">
                  <Coverage planned={b.planned} target={b.hours} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/** Jahrgang im Link: Zahl oder „ohne“ (Klassen ohne Jahrgang) */
const gradeParamOf = (g: number | null) => (g === null ? "ohne" : String(g));

/**
 * SP3-LA: Matrix Klasse × Fach je Jahrgang – Stundentafel-Soll und Lehraufträge am Stichtag, Lehrkraft per Typeahead, live Deputatsbilanz,
 * Übernahme aus dem 1. Halbjahr bzw. dem Vorjahr als Vorschlag (F-10-7).
 */
async function MatrixView({
  d,
  year,
  accounts,
  teachers,
  gradeParam,
  vorschlag,
  stichtag,
  readOnly,
}: {
  d: Distribution;
  year: { id: string; name: string; startsOn: string; endsOn: string; term2StartsOn: string | null };
  accounts: DeputyAccount[];
  teachers: PickTeacher[];
  gradeParam?: string;
  vorschlag?: string;
  stichtag?: string;
  readOnly: boolean;
}) {
  const db = await getDb();
  const classes = matrixClasses(d);
  const grades = matrixGrades(classes);
  if (!grades.length)
    return (
      <EmptyState title={`Noch keine Klassen im Schuljahr ${year.name}`}>
        Die Matrix zeigt Klassen des Schuljahrs. Im Folgejahr entstehen sie mit der Versetzung im{" "}
        <Link href="/verwaltung/schuljahreswechsel" className="font-medium text-accent-ink underline">
          Schuljahreswechsel
        </Link>
        , sonst unter Verwaltung → Gruppen.
      </EmptyState>
    );
  const grade = grades.find((g) => gradeParamOf(g) === gradeParam) ?? grades[0]!;
  const gradeName = (g: number | null) => (g === null ? "ohne Jahrgang" : `Jahrgang ${g}`);
  const matrix = await loadMatrix(db, d, grade);
  const source = !readOnly && (vorschlag === "vorjahr" || vorschlag === "halbjahr") ? vorschlag : null;
  const result: SuggestionResult | null = source ? await matrixSuggestions(db, year, d.refYmd, matrix, source) : null;
  const term2 = year.term2StartsOn && year.term2StartsOn > year.startsOn && d.refYmd >= year.term2StartsOn;
  const base = { ansicht: "matrix", jahrgang: gradeParamOf(grade), stichtag };
  const editHref: Record<string, string> = {};
  for (const r of matrix.rows) for (const c of r.cells) for (const a of c.assignments) editHref[a.id] = href({ gruppe: r.groupId, auftrag: a.id, stichtag });
  return (
    <section aria-labelledby="mx" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="mx" className="font-display text-xl font-bold">
          Matrix Klasse × Fach · {gradeName(grade)}
        </h2>
        <div className={readOnly ? "hidden" : "flex flex-wrap gap-2"}>
          {term2 && (
            <Button asChild size="sm" variant={source === "halbjahr" ? "secondary" : "ghost"}>
              <Link href={href({ ...base, vorschlag: "halbjahr" })}>Aus dem 1. Halbjahr übernehmen</Link>
            </Button>
          )}
          <Button asChild size="sm" variant={source === "vorjahr" ? "secondary" : "ghost"}>
            <Link href={href({ ...base, vorschlag: "vorjahr" })}>Aus dem Vorjahr übernehmen</Link>
          </Button>
        </div>
      </div>
      <nav aria-label="Jahrgang" className="flex flex-wrap gap-1">
        {grades.map((g) => (
          <Button key={gradeParamOf(g)} asChild size="sm" variant={g === grade ? "secondary" : "ghost"}>
            <Link href={href({ ...base, jahrgang: gradeParamOf(g) })} aria-current={g === grade ? "page" : undefined}>
              {g === null ? "ohne Jahrgang" : g}
            </Link>
          </Button>
        ))}
      </nav>
      {result && (
        <p role="note" className="rounded-lg border border-border bg-accent-soft px-3 py-2 text-sm text-accent-ink">
          {result.missing
            ? `Keine Übernahme möglich: ${result.missing}`
            : result.suggestions.length === 0
            ? `Keine Vorschläge ${result.label} für leere Zellen in ${gradeName(grade)}.`
            : `${result.suggestions.length} ${result.suggestions.length === 1 ? "Vorschlag" : "Vorschläge"} ${result.label}: Lehrkraft folgt der Klasse, Stunden laut Stundentafel. Prüfen, einzeln ändern oder mit Esc verwerfen – gespeichert wird erst mit „Änderungen speichern“. Kurse und Bänder werden nicht übernommen.`}
          {result.reconstructed && " Die Zuordnung der Klassen stammt aus den Klassennamen (Schuljahreswechsel vor dieser Funktion)."}{" "}
          <Link href={href(base)} className="font-medium underline">
            Vorschläge ausblenden
          </Link>
        </p>
      )}
      {matrix.rows.length === 0 || matrix.columns.length === 0 ? (
        <EmptyState title="Keine Fächer">Für {gradeName(grade)} gibt es weder Stundentafel noch Lehraufträge – Stundentafel unter Stammdaten pflegen.</EmptyState>
      ) : readOnly ? (
        <p role="note" className="text-sm text-muted">
          Abgeschlossenes Schuljahr: die Matrix ist nur lesbar – die Lehraufträge stehen unter „Klassen &amp; Kurse“.
        </p>
      ) : (
        <MatrixEditor
          key={`${year.id}|${gradeParamOf(grade)}|${d.refYmd}|${source ?? ""}`}
          matrix={matrix}
          accounts={accounts.map(({ id, code, name, target, assigned }) => ({ id, code, name, target, assigned }))}
          teachers={teachers}
          refYmd={d.refYmd}
          suggestions={result?.suggestions ?? []}
          source={source ?? "matrix"}
          editHref={editHref}
          save={saveMatrixAction.bind(null, year.id)}
        />
      )}
    </section>
  );
}

/**
 * SP2-03: Tagesgrenzen und Ganztag je Jahrgang – höchstens n Stunden am Tag, Mittag nach der n-ten Stunde, höchstens n Nachmittage.
 * Gilt für die Klassen des Jahrgangs (Kurse des Jahrgangs zählen mit); hart in Solver und Setzhilfe, geprüft in der Diagnose.
 */
async function LimitsView({ saved }: { saved?: string }) {
  const db = await getDb();
  const [grades, rules, periodRows, school] = await Promise.all([
    classGrades(db),
    listGradeRules(db),
    db.select({ nr: periods.nr, startsAt: periods.startsAt, endsAt: periods.endsAt }).from(periods).orderBy(periods.nr),
    readSchoolSettings(db),
  ]);
  const byGrade = new Map(rules.map((r) => [r.grade, r]));
  const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  const rows = grades.map((grade) => {
    const r = byGrade.get(grade);
    const eff = r ? dayRuleFor(r, periodRows) : null;
    const inGrid = r?.lunchAfterPeriod != null && eff?.lunchPeriod === null ? `Mittagspause im Zeitraster nach der ${r.lunchAfterPeriod}. Stunde` : null;
    const effect = eff ? [ruleSummary(eff), inGrid].filter(Boolean).join(" · ") : "keine Grenzen";
    return { grade, maxPerDay: str(r?.maxPerDay), afternoonsPerWeek: str(r?.afternoonsPerWeek), lunchAfterPeriod: str(r?.lunchAfterPeriod), effect };
  });
  return (
    <section aria-labelledby="limits" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="limits" className="font-display text-xl font-bold">
          Tagesgrenzen und Ganztag
        </h2>
        <form action={applyGradeRuleDefaultsAction}>
          <Button type="submit" variant="secondary">
            Vorgaben der Schulform übernehmen
          </Button>
        </form>
      </div>
      <p className="-mt-2 text-sm text-muted">
        Je Jahrgang für alle Klassen; Stunden der Kurse, Wahlpflicht- und Förderkurse des Jahrgangs zählen mit. Ist zwischen der Mittagsstunde und der nächsten Stunde
        schon eine Pause von mindestens {LUNCH_MIN_MINUTES} Minuten im Zeitraster, liegt die Mittagspause dort; sonst bleibt die Stunde danach frei, sobald noch
        Unterricht folgt. Nachmittag ist alles nach der Mittagspause. Leeres Feld = keine Grenze. Die automatische Planung und die Setzhilfe halten die Grenzen ein, die
        Diagnose zeigt Verstöße im Plan. Vorgaben der Schulform ({formName(school.profile.form, school.profile.state)}) überschreiben die Werte aller Jahrgänge.
      </p>
      {saved && (
        <p role="status" className="text-sm text-success">
          {saved === "vorgaben" ? "Vorgaben der Schulform übernommen." : "Tagesgrenzen gespeichert."}
        </p>
      )}
      {grades.length === 0 ? (
        <EmptyState title="Noch keine Klassen mit Jahrgang">Tagesgrenzen gelten je Jahrgang – lege zuerst Klassen mit Jahrgangsstufe an.</EmptyState>
      ) : (
        <GradeRulesForm action={saveGradeRulesAction} rows={rows} periodCount={periodRows.length} />
      )}
    </section>
  );
}
