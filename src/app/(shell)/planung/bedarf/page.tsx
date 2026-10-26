import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { subjects, users } from "@/core/db/schema";
import { hasPermission } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { addStaffChangeAction, deleteStaffChangeAction, saveForecastGradesAction } from "@/modules/stundenplan/actions";
import { loadFachbedarf, type ForecastNeed, type NeedTone, type SubjectNeed } from "@/modules/stundenplan/fachbedarf";
import { PLAN_FORECAST, PLAN_MANAGE } from "@/modules/stundenplan/rechte";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader, SubjectBar } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ForecastGradesForm, StaffChangeForm } from "./forms";

export const metadata: Metadata = { title: "Fachbedarf" };

const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "UTC" });
const fmtYmd = (ymd: string) => dateFmt.format(new Date(`${ymd}T00:00:00Z`));

const TONE_LABEL: Record<NeedTone, string> = { success: "gedeckt", warn: "knapp", danger: "Lücke" };

/** Saldo Versorgung − Bedarf mit Ampel */
function Saldo({ balance, tone }: { balance: number; tone: NeedTone }) {
  const sign = balance > 0 ? "+" : balance < 0 ? "−" : "±";
  return (
    <Badge tone={tone} title={TONE_LABEL[tone]}>
      {sign}
      {num.format(Math.abs(balance))}
      <span className="sr-only"> – {TONE_LABEL[tone]}</span>
    </Badge>
  );
}

function Advice({ rows }: { rows: { advice: string[] }[] }) {
  const all = rows.flatMap((r) => r.advice);
  if (!all.length) return <p className="text-sm text-muted">Keine Empfehlungen – alle Fächer sind gedeckt und haben mehr als eine Lehrkraft.</p>;
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {all.map((a) => (
        <li key={a}>{a}</li>
      ))}
    </ul>
  );
}

function CurrentTable({ rows, details }: { rows: SubjectNeed[]; details: boolean }) {
  return (
    <Table scrollLabel="Bedarf und Versorgung je Fach">
      <caption className="sr-only">Bedarf und Versorgung je Fach im laufenden Schuljahr</caption>
      <thead>
        <tr>
          <th>Fach</th>
          <th className="text-right">Lehraufträge</th>
          <th className="text-right">fehlt laut Stundentafel</th>
          <th className="text-right">Bedarf</th>
          <th className="text-right">Versorgung</th>
          <th className="text-right">Saldo</th>
          <th>Lehrkräfte mit Lehrfach</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.subjectId} data-fach={r.subjectId}>
            <td>
              <span className="flex items-center gap-2 font-medium">
                <SubjectBar color={r.color} className="h-5 w-1 shrink-0" />
                {r.name}
              </span>
            </td>
            <td className="text-right tabular-nums">{num.format(r.assigned)}</td>
            <td className="text-right tabular-nums">{r.missing ? num.format(r.missing) : "–"}</td>
            <td className="text-right font-medium tabular-nums">{num.format(r.demand)}</td>
            <td className="text-right tabular-nums">{num.format(r.supply)}</td>
            <td className="text-right">
              <Saldo balance={r.balance} tone={r.tone} />
            </td>
            <td>
              <span className="flex flex-wrap items-center gap-1">
                {r.teacherCount === 0 ? <Badge tone="danger">keine</Badge> : r.teacherCount === 1 && r.demand > 0 ? <Badge tone="warn">nur eine</Badge> : <span className="tabular-nums">{r.teacherCount}</span>}
                {details && r.teachers && r.teachers.length > 0 && (
                  <span className="text-xs text-muted">{r.teachers.map((t) => `${t.code ?? t.name} ${num.format(t.hours)}`).join(" · ")}</span>
                )}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ForecastTable({ rows }: { rows: ForecastNeed[] }) {
  return (
    <Table scrollLabel="Prognose je Fach">
      <caption className="sr-only">Prognose Bedarf und Versorgung je Fach im nächsten Schuljahr</caption>
      <thead>
        <tr>
          <th>Fach</th>
          <th className="text-right">Bedarf</th>
          <th className="text-right">Versorgung</th>
          <th className="text-right">davon weg</th>
          <th className="text-right">davon neu</th>
          <th className="text-right">Saldo</th>
          <th className="text-right">Lehrkräfte</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.subjectId} data-prognose={r.subjectId}>
            <td>
              <span className="flex items-center gap-2 font-medium">
                <SubjectBar color={r.color} className="h-5 w-1 shrink-0" />
                {r.name}
              </span>
            </td>
            <td className="text-right font-medium tabular-nums">{num.format(r.demand)}</td>
            <td className="text-right tabular-nums">{num.format(r.supply)}</td>
            <td className="text-right tabular-nums">{r.leaving ? `−${num.format(r.leaving)}` : "–"}</td>
            <td className="text-right tabular-nums">{r.joining ? `+${num.format(r.joining)}` : "–"}</td>
            <td className="text-right">
              <Saldo balance={r.balance} tone={r.tone} />
            </td>
            <td className="text-right tabular-nums">{r.teacherCount}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * SP2-12 (Projektleitung 2026-10-19): Fachbedarf & Vorsorge. Die Planung (`stundenplan.manage`) sieht Details und pflegt Prognose,
 * Abgänge und Zugänge; „Fachbedarf einsehen“ (`stundenplan.forecast_view`, Schulleitung) nur Summen je Fach – ohne Namen.
 */
export default async function FachbedarfPage() {
  const { perms } = await requireUser();
  const manage = hasPermission(perms, PLAN_MANAGE);
  if (!manage && !hasPermission(perms, PLAN_FORECAST)) notFound();
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const f = await loadFachbedarf(db, today, { details: manage });
  if (!f) {
    return (
      <main className="flex flex-col gap-6">
        <PageHeader eyebrow="Stundenplanung" title="Fachbedarf" />
        <EmptyState title="Kein Schuljahr angelegt">Lege unter Stammdaten → Schuljahre zuerst ein Schuljahr an.</EmptyState>
      </main>
    );
  }
  const [subjectRows, teacherRows] = manage
    ? await Promise.all([
        db.select({ id: subjects.id, name: subjects.name }).from(subjects).orderBy(asc(subjects.sortOrder), asc(subjects.id)),
        // R2-P2: Abgang nur für aktive Lehrkräfte
        db
          .select({ id: users.id, code: users.shortCode, name: users.name })
          .from(users)
          .where(and(eq(users.role, "lehrkraft"), eq(users.status, "active")))
          .orderBy(asc(users.shortCode)),
      ])
    : [[], []];
  const subjectName = new Map(subjectRows.map((s) => [s.id, s.name]));
  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Stundenplanung" title="Fachbedarf" />
      <p className="-mt-3 text-sm text-muted">
        Schuljahr {f.year.name} · Lehraufträge am {fmtYmd(f.refYmd)} · Wochenstunden (Lehrerstunden)
        {!manage && " · nur Summen je Fach, ohne Namen"}
      </p>
      {f.unmaintained > 0 && (
        <p role="note" className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2 text-sm text-warn">
          {f.unmaintained === 1 ? "1 Lehrkraft hat" : `${f.unmaintained} Lehrkräfte haben`} noch keine Lehrfächer – ihr Deputat zählt in keiner Versorgung.
          {manage && f.teachersWithoutSubjects && (
            <>
              {" "}
              {f.teachersWithoutSubjects.map((t, i) => (
                <span key={t.id}>
                  {i > 0 && ", "}
                  <Link href={`/planung/unterricht?ansicht=lehrkraefte&lehrkraft=${encodeURIComponent(t.id)}`} className="font-medium underline">
                    {t.code ?? t.name}
                  </Link>
                </span>
              ))}{" "}
              ·{" "}
              <Link href="/planung/unterricht/lehrfaecher" className="font-medium underline">
                Lehrfächer per CSV importieren
              </Link>
            </>
          )}
        </p>
      )}

      <section aria-labelledby="aktuell" className="flex flex-col gap-3">
        <h2 id="aktuell" className="font-display text-xl font-bold">
          Laufendes Schuljahr
        </h2>
        <p className="-mt-1 text-sm text-muted">
          Bedarf = Lehraufträge (Teamteaching je Lehrkraft, ein Band je Lehrkraft einmal) plus Stunden, die Klassen laut Stundentafel noch fehlen. Versorgung = Soll der
          Lehrkräfte mit dem Lehrfach (nach Ermäßigungen und Anrechnungen): ihre Lehraufträge in diesen Fächern plus freies Soll, gleichmäßig auf ihre Lehrfächer
          verteilt. Ampel: gedeckt · knapp (Lücke bis 2 Std. bzw. 10 %) · Lücke.
        </p>
        {f.current.length === 0 ? <EmptyState title="Noch keine Lehraufträge und keine Lehrfächer" /> : <CurrentTable rows={f.current} details={manage} />}
        <h3 className="font-semibold">Empfehlungen</h3>
        <Advice rows={f.current} />
      </section>

      <section aria-labelledby="prognose" className="flex flex-col gap-3">
        <h2 id="prognose" className="font-display text-xl font-bold">
          Prognose {f.next.name}
        </h2>
        <p className="-mt-1 text-sm text-muted">
          Klassen rücken einen Jahrgang auf, der unterste Jahrgang bleibt wie bisher (anpassbar). Stunden je Klasse aus der Stundentafel, sonst wie die Lehraufträge des
          Jahrgangs heute; Kurse, AGs und Wahlpflicht wie im laufenden Jahr. Abgänge und Zugänge bis {fmtYmd(f.next.endsOn)} zählen voll.
        </p>
        {f.grades.length > 0 && (
          <Card aria-labelledby="klassen" className="flex flex-col gap-3">
            <h3 id="klassen" className="text-base font-semibold">
              Klassen je Jahrgang
            </h3>
            {manage ? (
              <ForecastGradesForm action={saveForecastGradesAction} grades={f.grades} />
            ) : (
              <p className="text-sm">
                {f.grades.map((g) => `Jg. ${g.grade}: ${g.next}`).join(" · ")}
              </p>
            )}
          </Card>
        )}
        {f.forecast.length === 0 ? <EmptyState title="Keine Prognose möglich" /> : <ForecastTable rows={f.forecast} />}
        <h3 className="font-semibold">Empfehlungen {f.next.name}</h3>
        <Advice rows={f.forecast} />
      </section>

      {manage && f.changes && (
        <section aria-labelledby="personal" className="flex flex-col gap-3">
          <h2 id="personal" className="font-display text-xl font-bold">
            Abgänge und Zugänge
          </h2>
          <p className="-mt-1 text-sm text-muted">
            Nur Datum und Stunden – bewusst ohne Grund. Sichtbar nur für die Planung; die Schulleitung sieht nur die Summen je Fach. Ein Jahr nach dem Datum werden die Einträge
            gelöscht.
          </p>
          {f.changes.length > 0 && (
            <Table>
              <caption className="sr-only">Abgänge und Zugänge</caption>
              <thead>
                <tr>
                  <th>Art</th>
                  <th>Wer / Fächer</th>
                  <th>ab</th>
                  <th className="text-right">Stunden</th>
                  <th>
                    <span className="sr-only">Aktion</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {f.changes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.kind === "abgang" ? <Badge tone="warn">Abgang</Badge> : <Badge tone="success">Zugang</Badge>}</td>
                    <td>{c.kind === "abgang" ? `${c.teacherCode ?? "–"} · ${c.teacherName ?? ""}` : c.subjectIds.map((s) => subjectName.get(s) ?? s).join(", ")}</td>
                    <td>{fmtYmd(c.effectiveOn)}</td>
                    <td className="text-right tabular-nums">{num.format(c.hours)}</td>
                    <td className="text-right">
                      <form action={deleteStaffChangeAction.bind(null, c.id)}>
                        <Button type="submit" size="sm" variant="ghost" aria-label={`${c.kind === "abgang" ? "Abgang" : "Zugang"} vom ${fmtYmd(c.effectiveOn)} entfernen`}>
                          Entfernen
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Card aria-labelledby="neu-personal">
            <h3 id="neu-personal" className="text-base font-semibold">
              Abgang oder Zugang eintragen
            </h3>
            <StaffChangeForm
              action={addStaffChangeAction}
              teachers={teacherRows.map((t) => ({ value: t.id, label: `${t.code ?? "–"} – ${t.name}` }))}
              subjects={subjectRows.map((s) => ({ value: s.id, label: s.name }))}
              defaultDate={f.next.startsOn}
            />
          </Card>
        </section>
      )}
    </main>
  );
}
