import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Plus, Wand2 } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { GROUP_KIND_LABELS } from "@/core/labels";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { REDUCTION_REASONS } from "@/core/db/schema";
import { readSchoolSettings } from "@/core/settings";
import {
  addReductionAction,
  deleteAssignmentAction,
  deleteReductionAction,
  importAssignmentsAction,
  saveAssignmentAction,
  saveObligationAction,
} from "@/modules/stundenplan/actions";
import { DIAGNOSIS_CATEGORIES, diagnoseYear, type DiagnosisCategory } from "@/modules/stundenplan/diagnose";
import { defaultObligation, deputyAccounts, REDUCTION_LABELS, reductionKind, type DeputyAccount } from "@/modules/stundenplan/deputate";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { distribution, planningYear, PLANNED_GROUP_KINDS, type Distribution } from "@/modules/stundenplan/verteilung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AssignmentForm, type AssignmentFormValues } from "./assignment-form";
import { ObligationForm, ReductionForm } from "./deputy-forms";
import { DiagnosisView } from "./diagnosis";

export const metadata: Metadata = { title: "Unterrichtsverteilung" };

type Search = { ansicht?: string; kategorie?: string; art?: string; gruppe?: string; lehrkraft?: string; neu?: string; auftrag?: string; uebernommen?: string };

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
  const year = await planningYear(db);
  if (!year) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplanung" title="Unterrichtsverteilung" />
        <EmptyState title="Kein Schuljahr angelegt">Lege unter Stammdaten → Schuljahre zuerst ein Schuljahr an.</EmptyState>
      </main>
    );
  }
  const today = toBerlinDate(new Date());
  const [d, master, school] = await Promise.all([distribution(db, year, today), timetableMasterData(db), readSchoolSettings(db)]);
  const fallback = defaultObligation(school.profile.form);
  const accounts = await deputyAccounts(db, year.id, d.teachers, fallback);
  const teachersView = sp.ansicht === "lehrkraefte";
  const diagnoseView = sp.ansicht === "diagnose";
  const report = diagnoseView ? await diagnoseYear(db, year, today, fallback, d) : null;
  const category = DIAGNOSIS_CATEGORIES.find((c): c is DiagnosisCategory => c === sp.kategorie);
  const group = d.groups.find((g) => g.id === sp.gruppe);
  const teacher = teachersView ? d.teachers.find((t) => t.id === sp.lehrkraft) : undefined;
  const current = { ansicht: teachersView ? "lehrkraefte" : diagnoseView ? "diagnose" : undefined, kategorie: diagnoseView ? category : undefined, art: sp.art, gruppe: group?.id, lehrkraft: teacher?.id };
  const back = href(current);

  // ------------------------------------------------------------ Formular
  const editing = sp.auftrag ? d.assignments.find((a) => a.id === sp.auftrag) : undefined;
  let form: React.ReactNode = null;
  if (editing || sp.neu !== undefined) {
    const [first, ...coupled] = editing?.groups.map((g) => g.id) ?? [group?.id ?? ""];
    const initial: AssignmentFormValues = {
      groupId: first ?? "",
      coupledGroupIds: coupled.join(","),
      subjectId: editing?.subjectId ?? "",
      hours: String(editing?.hours ?? 2),
      doubleLessons: String(editing?.doubleLessons ?? 0),
      teacherId: editing?.teachers[0]?.id ?? teacher?.id ?? "",
      teacher2Id: editing?.teachers[1]?.id ?? "",
      roomId: editing?.roomId ?? "",
      note: editing?.note ?? "",
    };
    form = (
      <Card aria-labelledby="assignment-form-title">
        <h2 id="assignment-form-title" className="text-base font-semibold">
          {editing ? `Lehrauftrag bearbeiten · ${editing.subjectName}` : "Lehrauftrag anlegen"}
        </h2>
        <AssignmentForm
          key={editing?.id ?? "neu"}
          action={saveAssignmentAction.bind(null, editing?.id ?? null)}
          deleteAction={editing ? deleteAssignmentAction.bind(null, editing.id, back) : undefined}
          initial={initial}
          back={back}
          options={{
            groups: PLANNED_GROUP_KINDS.map((k) => ({
              label: GROUP_KIND_LABELS[k],
              options: d.groups.filter((g) => g.kind === k).map((g) => ({ value: g.id, label: g.name })),
            })).filter((g) => g.options.length),
            subjects: master.subjects.map((s) => ({ value: s.id, label: s.name })),
            teachers: d.teachers.map((t) => ({ value: t.id, label: `${t.code ?? "–"} – ${t.name}` })),
            rooms: master.rooms.map((r) => ({ value: r.id, label: r.id === r.name ? r.id : `${r.id} – ${r.name}` })),
          }}
        />
      </Card>
    );
  }

  const unmatchedCount = d.unmatched.length;
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Stundenplanung"
        title="Unterrichtsverteilung"
        actions={
          <>
            {unmatchedCount > 0 && (
              <form action={importAssignmentsAction}>
                <Button type="submit">
                  <Wand2 aria-hidden /> Aus Stundenplan übernehmen ({unmatchedCount} Std.)
                </Button>
              </form>
            )}
            <Button asChild variant="primary">
              <Link href={href({ ...current, neu: "1" })}>
                <Plus aria-hidden /> Lehrauftrag anlegen
              </Link>
            </Button>
          </>
        }
      />
      <p className="-mt-3 text-sm text-muted">
        Schuljahr {year.name} · „verplant“ zählt die Stunden im Stundenplan am {dateFmt.format(new Date(`${d.refYmd}T00:00:00Z`))} (A-/B-Wochen halb).
      </p>
      {sp.uebernommen !== undefined && (
        <p role="status" className="rounded-xl border border-border bg-accent-soft px-4 py-3 text-sm text-accent-ink">
          {sp.uebernommen === "0" ? "Alle Stunden des Stundenplans haben schon einen Lehrauftrag." : `${sp.uebernommen} Lehraufträge aus dem Stundenplan übernommen.`}
        </p>
      )}
      <nav aria-label="Ansicht" className="flex gap-2">
        <Button asChild size="sm" variant={teachersView || diagnoseView ? "ghost" : "secondary"}>
          <Link href={href({})} aria-current={teachersView || diagnoseView ? undefined : "page"}>
            Klassen & Kurse
          </Link>
        </Button>
        <Button asChild size="sm" variant={teachersView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "lehrkraefte" })} aria-current={teachersView ? "page" : undefined}>
            Lehrkräfte
          </Link>
        </Button>
        <Button asChild size="sm" variant={diagnoseView ? "secondary" : "ghost"}>
          <Link href={href({ ansicht: "diagnose" })} aria-current={diagnoseView ? "page" : undefined}>
            Diagnose
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/planung/zeitwuensche">Zeitwünsche</Link>
        </Button>
      </nav>
      {form}
      {report ? (
        <DiagnosisView report={report} category={category} refLabel={`Stand ${dateFmt.format(new Date(`${d.refYmd}T00:00:00Z`))}`} />
      ) : group ? (
        <GroupDetail d={d} groupId={group.id} current={current} />
      ) : teacher ? (
        <TeacherDetail d={d} account={accounts.find((a) => a.id === teacher.id)!} fallback={fallback} current={current} />
      ) : teachersView ? (
        <TeacherOverview accounts={accounts} />
      ) : (
        <GroupOverview d={d} art={sp.art} />
      )}
    </main>
  );
}

type Current = Record<string, string | undefined>;

function GroupOverview({ d, art }: { d: Distribution; art?: string }) {
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
              <Link href={href({ art: k })} aria-current={k === kind ? "page" : undefined}>
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
                <Link href={href({ art: kind === "klasse" ? undefined : kind, gruppe: g.id })} className="font-medium hover:underline">
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

function TeacherOverview({ accounts }: { accounts: DeputyAccount[] }) {
  return (
    <section aria-labelledby="ov" className="flex flex-col gap-3">
      <h2 id="ov" className="font-display text-xl font-bold">
        Deputatskonto je Lehrkraft
      </h2>
      <Table>
        <thead>
          <tr>
            <th>Lehrkraft</th>
            <th className="text-right">Soll</th>
            <th className="text-right">Lehraufträge</th>
            <th className="text-right">Saldo</th>
            <th className="text-right">verplant</th>
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
              </td>
              <td className="text-right tabular-nums">{num.format(t.assigned)}</td>
              <td className="text-right">
                <Balance balance={t.balance} />
              </td>
              <td className="text-right">
                <Coverage planned={t.planned} target={t.assigned} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function AssignmentTable({ rows, current, caption, show }: { rows: Distribution["assignments"]; current: Current; caption: string; show: "teachers" | "groups" }) {
  if (!rows.length) return <EmptyState title="Noch keine Lehraufträge" />;
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
                {show === "teachers" && a.groups.length > 1 && <Badge>gekoppelt: {a.groups.length} Gruppen</Badge>}
                {show === "groups" && a.teachers.length > 1 && <Badge>Team: {a.teachers.map((t) => t.code).join(" + ")}</Badge>}
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
      <BackLink to={href({ art: current.art })} label="Alle Gruppen" />
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="gd" className="font-display text-xl font-bold">
          {g.name}
        </h2>
        {g.homeRoomId && <Badge>Stammraum {g.homeRoomId}</Badge>}
        {g.curriculum !== null && <Badge>Stundentafel {num.format(g.curriculum)}</Badge>}
        <Badge>Lehraufträge {num.format(g.assigned)}</Badge>
        <Coverage planned={g.planned} target={g.assigned} />
      </div>
      <AssignmentTable rows={rows} current={current} caption={`Lehraufträge ${g.name}`} show="teachers" />
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

function DeputyCard({ account: a, fallback }: { account: DeputyAccount; fallback: number }) {
  const reductionSum = a.reductions.reduce((s, r) => s + r.hours, 0);
  return (
    <Card aria-labelledby="dep" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="dep" className="text-base font-semibold">
          Deputat
        </h3>
        <p className="text-sm text-muted">
          Pflicht {num.format(a.obligation)}
          {a.isDefault && " (Vorgabe)"} − Ermäßigungen/Anrechnungen {num.format(reductionSum)} = <strong className="text-ink">Soll {num.format(a.target)}</strong> · Lehraufträge {num.format(a.assigned)} ·{" "}
          Saldo <Balance balance={a.balance} />
        </p>
      </div>
      <ObligationForm action={saveObligationAction.bind(null, a.id)} value={a.isDefault ? "" : num.format(a.obligation)} fallback={num.format(fallback)} />
      {a.reductions.length > 0 && (
        <Table>
          <caption className="sr-only">Ermäßigungen und Anrechnungen</caption>
          <thead>
            <tr>
              <th>Grund</th>
              <th>Art</th>
              <th className="text-right">Stunden</th>
              <th>
                <span className="sr-only">Aktionen</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {a.reductions.map((r) => (
              <tr key={r.id}>
                <td>
                  {REDUCTION_LABELS[r.reason]}
                  {r.note && <span className="text-muted"> · {r.note}</span>}
                </td>
                <td className="text-muted">{reductionKind(r.reason)}</td>
                <td className="text-right tabular-nums">{num.format(r.hours)}</td>
                <td className="text-right">
                  <form action={deleteReductionAction.bind(null, r.id, a.id)}>
                    <Button type="submit" size="sm" variant="ghost" aria-label={`${REDUCTION_LABELS[r.reason]} entfernen`}>
                      Entfernen
                    </Button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ReductionForm action={addReductionAction.bind(null, a.id)} reasons={REDUCTION_REASONS.map((r) => ({ value: r, label: `${REDUCTION_LABELS[r]} (${reductionKind(r)})` }))} />
    </Card>
  );
}

function TeacherDetail({ d, account, fallback, current }: { d: Distribution; account: DeputyAccount; fallback: number; current: Current }) {
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
      <DeputyCard account={account} fallback={fallback} />
      <AssignmentTable rows={rows} current={current} caption={`Lehraufträge ${t.name}`} show="groups" />
      <Unmatched rows={d.unmatched.filter((l) => l.teacherId === teacherId)} />
    </section>
  );
}
