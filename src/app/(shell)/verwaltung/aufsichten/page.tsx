import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { X } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import {
  addDutyAction,
  clearDutyChangeAction,
  createAreaAction,
  deleteAreaAction,
  removeDutyAction,
  setDutyChangeAction,
} from "@/modules/stundenplan/actions";
import { dutiesOn, dutyCandidates, dutyPlan, listAreas, schoolBreaks } from "@/modules/stundenplan/aufsichten";
import { teacherOptions, WEEKDAYS } from "@/modules/stundenplan/manage";
import { planDays } from "@/modules/stundenplan/vertretung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { Input, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { AreaForm, DutyForm } from "./forms";

export const metadata: Metadata = { title: "Pausenaufsichten" };

const longDay = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
const STATUS = {
  regular: { label: "", tone: "neutral" },
  open: { label: "offen", tone: "danger" },
  covered: { label: "vertreten", tone: "warn" },
  dropped: { label: "entfällt", tone: "neutral" },
} as const;

/** Pausenaufsichten: Tagesansicht mit offenen Aufsichten, Aufsichtsplan je Bereich, Bereiche. */
export default async function AufsichtenPage({ searchParams }: { searchParams: Promise<{ datum?: string; fehler?: string }> }) {
  const { perms } = await requireUser();
  // SP-02: Aufsichtsplan und Bereiche = Jahresplanung (`manage`), Tagesansicht mit Vertretung = Tagesgeschäft (`substitute`)
  const canManage = hasPermission(perms, "stundenplan.manage");
  const canSubstitute = hasPermission(perms, "stundenplan.substitute");
  if (!canManage && !canSubstitute) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const cal = await loadSchoolCalendar(db);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.datum ?? "") ? sp.datum! : planDays(toBerlinDate(new Date()), cal)[0];
  const [areas, breaks, plan, teachers, day] = await Promise.all([listAreas(db), schoolBreaks(db), dutyPlan(db), teacherOptions(db), cal.dayOff(date) ? Promise.resolve([]) : dutiesOn(db, date)]);
  const openDuties = day.filter((d) => d.status === "open");
  const candidates = new Map(await Promise.all(openDuties.map(async (d) => [d.id, await dutyCandidates(db, d.id, date)] as const)));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Verwaltung" title="Pausenaufsichten" />
      {sp.fehler && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {sp.fehler}
        </p>
      )}

      <section aria-labelledby="day-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="day-title" className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
            Aufsichten am {longDay.format(fromBerlinLocal(date))}
            {openDuties.length > 0 && <Badge tone="danger">{openDuties.length} offen</Badge>}
          </h2>
          <form className="flex items-end gap-2" aria-label="Tag wählen">
            <Input type="date" name="datum" defaultValue={date} aria-label="Datum" className="w-44" />
            <Button type="submit">Anzeigen</Button>
          </form>
        </div>
        {day.length === 0 ? (
          <EmptyState title="Keine Aufsichten an diesem Tag" />
        ) : (
          <Table>
            <caption className="sr-only">Aufsichten am {longDay.format(fromBerlinLocal(date))}</caption>
            <thead>
              <tr>
                <th>Pause</th>
                <th>Bereich</th>
                <th>Lehrkraft</th>
                <th>Status</th>
                <th>Vertretung</th>
              </tr>
            </thead>
            <tbody>
              {day.map((d) => (
                <tr key={d.id}>
                  <td className="whitespace-nowrap">
                    {d.breakLabel} <span className="text-muted">{d.startsAt}</span>
                  </td>
                  <td>{d.areaName}</td>
                  <td className={d.absent ? "text-muted line-through" : undefined}>{d.teacherCode}</td>
                  <td>{d.status !== "regular" && <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>}</td>
                  <td>
                    {!canSubstitute ? (
                      (d.change?.substituteCode ?? null)
                    ) : d.status === "open" ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <form action={setDutyChangeAction.bind(null, d.id, date)} className="flex items-center gap-2">
                          <Select name="substituteId" aria-label={`Vertretung ${d.breakLabel} ${d.areaName}`} className="h-9 w-48" required>
                            {(candidates.get(d.id) ?? []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.code} {c.inHouse ? "· im Haus" : ""}
                              </option>
                            ))}
                          </Select>
                          <Button type="submit" size="sm">
                            Übernehmen
                          </Button>
                        </form>
                        <form action={setDutyChangeAction.bind(null, d.id, date)}>
                          <Button type="submit" size="sm" variant="ghost">
                            entfällt
                          </Button>
                        </form>
                      </span>
                    ) : d.change ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {d.change.substituteCode ?? "–"}
                        <form action={clearDutyChangeAction.bind(null, d.change.id, date)}>
                          <Button type="submit" size="sm" variant="ghost" aria-label={`Änderung ${d.breakLabel} ${d.areaName} aufheben`}>
                            Aufheben
                          </Button>
                        </form>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {canManage && (
        <section aria-labelledby="plan-title" className="flex flex-col gap-3">
          <h2 id="plan-title" className="font-display text-xl font-bold">
            Aufsichtsplan
          </h2>
          {breaks.length === 0 ? (
            <EmptyState title="Keine Pausen im Zeitraster">Pausen ergeben sich aus Lücken von mindestens 10 Minuten zwischen zwei Stunden.</EmptyState>
          ) : (
            <>
              <Card>
                <DutyForm
                  action={addDutyAction}
                  areas={areas.map((a) => ({ value: a.id, label: a.name }))}
                  weekdays={WEEKDAYS.map((w, i) => ({ value: String(i), label: w }))}
                  breaks={breaks.map((b) => ({ value: String(b.afterPeriod), label: `${b.label} (${b.startsAt}–${b.endsAt})` }))}
                  teachers={teachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.name}` }))}
                />
              </Card>
              {areas.map((a) => (
                <Table key={a.id}>
                  <caption className="px-4 pt-3 text-left font-semibold">{a.name}</caption>
                  <thead>
                    <tr>
                      <th>Pause</th>
                      {WEEKDAYS.map((w) => (
                        <th key={w}>{w}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {breaks.map((b) => (
                      <tr key={b.afterPeriod}>
                        <td className="whitespace-nowrap">
                          {b.label}
                          <span className="block text-xs text-muted">
                            {b.startsAt}–{b.endsAt}
                          </span>
                        </td>
                        {WEEKDAYS.map((w, wd) => (
                          <td key={w}>
                            <span className="flex flex-wrap gap-1">
                              {plan
                                .filter((p) => p.areaId === a.id && p.weekday === wd && p.afterPeriod === b.afterPeriod)
                                .map((p) => (
                                  <form key={p.id} action={removeDutyAction.bind(null, p.id)}>
                                    <button
                                      type="submit"
                                      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold ring-1 ring-border hover:ring-border-strong"
                                      aria-label={`${p.teacherCode} aus ${a.name} ${w} ${b.label} entfernen`}
                                    >
                                      {p.teacherCode} <X aria-hidden className="size-3" />
                                    </button>
                                  </form>
                                ))}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ))}
            </>
          )}
        </section>
      )}

      {canManage && (
        <section aria-labelledby="areas-title" className="flex flex-col gap-3">
          <h2 id="areas-title" className="font-display text-xl font-bold">
            Bereiche
          </h2>
          <ul className="flex flex-wrap gap-2">
            {areas.map((a) => (
              <li key={a.id} className="flex items-center gap-1 rounded-xl border border-border bg-surface py-1 pr-1 pl-3 text-sm">
                {a.name}
                <form action={deleteAreaAction.bind(null, a.id)}>
                  <Button type="submit" size="sm" variant="ghost" aria-label={`Bereich ${a.name} löschen`}>
                    Löschen
                  </Button>
                </form>
              </li>
            ))}
          </ul>
          <AreaForm action={createAreaAction} />
        </section>
      )}
    </main>
  );
}
