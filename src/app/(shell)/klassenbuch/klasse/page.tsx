import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { auditRead } from "@/core/audit";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { schoolYears } from "@/core/db/schema";
import { dayOffLabel, loadSchoolCalendar } from "@/core/school/calendar";
import { TZ, addDays, fromBerlinLocal, isoWeek, mondayOf, toBerlinDate } from "@/core/time";
import { absenceSummary, canReadClass, classWeek, readableClasses } from "@/modules/klassenbuch/service";
import { WEEKDAYS } from "@/modules/stundenplan/manage";
import { weekOf } from "@/modules/stundenplan/service";
import { Button } from "@schulos/ui/button";
import { cn } from "@schulos/ui/cn";
import { Select } from "@schulos/ui/field";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Klassenbuch der Klasse" };

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: TZ });
const fmt = (ymd: string) => shortDate.format(fromBerlinLocal(ymd));

export default async function KlasseKlassenbuchPage({ searchParams }: { searchParams: Promise<{ gruppe?: string; woche?: string; zeitraum?: string }> }) {
  const { user, perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  const classes = await readableClasses(db, perms);
  const group = classes.find((c) => c.id === sp.gruppe) ?? (classes.length === 1 ? classes[0] : undefined);
  if (classes.length === 0 || (sp.gruppe && !canReadClass(perms, sp.gruppe))) notFound();

  const today = toBerlinDate(new Date());
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(sp.woche ?? "") ? mondayOf(sp.woche!) : mondayOf(today);
  const days = WEEKDAYS.map((_, i) => addDays(monday, i));
  const cal = await loadSchoolCalendar(db);
  const offOf = (d: string) => cal.dayOff(d);
  const range = sp.zeitraum === "monat" ? "monat" : "schuljahr";
  const [year] = await db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
  const from = range === "monat" ? `${today.slice(0, 8)}01` : (year?.startsOn ?? `${today.slice(0, 4)}-08-01`);

  // Klassenbuch und Fehlzeiten sind sensibel: Lesezugriff protokollieren (DS-08)
  if (group) await auditRead(db, user.id, "lesen.klassenbuch", group.id, { fehlzeiten: range });
  const [week, sums] = group ? await Promise.all([classWeek(db, group.id, monday, today), absenceSummary(db, group.id, from, today)]) : [[], []];
  const missing = week.filter((c) => c.status === "missing").length;
  const lastPeriod = Math.max(6, ...week.map((c) => c.periodNr));
  const href = (q: Record<string, string>) => `/klassenbuch/klasse?${new URLSearchParams({ ...(group ? { gruppe: group.id } : {}), woche: monday, zeitraum: range, ...q })}`;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Klassenbuch" title={group ? group.name : "Klassenbuch einer Klasse"} />
      {classes.length > 1 && (
        <form className="flex flex-wrap items-end gap-3">
          <Select name="gruppe" defaultValue={group?.id ?? ""} aria-label="Klasse" className="w-56">
            <option value="">Klasse wählen …</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button type="submit">Anzeigen</Button>
        </form>
      )}

      {group && (
        <>
          <section aria-labelledby="woche" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1">
              <Button asChild variant="ghost" size="icon">
                <Link href={href({ woche: addDays(monday, -7) })} aria-label="Vorige Woche">
                  <ChevronLeft aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="ghost" size="icon">
                <Link href={href({ woche: addDays(monday, 7) })} aria-label="Nächste Woche">
                  <ChevronRight aria-hidden />
                </Link>
              </Button>
              <h2 id="woche" className="ml-1 font-semibold">
                KW {isoWeek(monday)} · {weekOf(monday)}-Woche
                <span className="font-normal text-muted">
                  {" "}
                  · {fmt(monday)} – {fmt(days[4]!)}
                </span>
                {missing > 0 && <span className="ml-2 font-semibold text-warn">{missing} Einträge fehlen</span>}
              </h2>
            </div>
            <div className="overflow-x-auto rounded-card border border-border bg-surface">
              <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="w-16 px-3 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">Std.</th>
                    {days.map((d, i) => (
                      <th key={d} className="px-2 py-3 text-left text-xs font-semibold tracking-wide text-muted uppercase">
                        {WEEKDAYS[i]} <span className="font-normal normal-case">{fmt(d)}</span>
                        {offOf(d) && <span className="block truncate font-normal normal-case tracking-normal">{dayOffLabel(offOf(d)!)}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: lastPeriod }, (_, k) => k + 1).map((p) => (
                    <tr key={p} className="border-t border-border">
                      <td className="px-3 py-2 align-top font-semibold">{p}.</td>
                      {days.map((d) => (
                        <td key={d} className={offOf(d) ? "bg-surface-2/60 px-1.5 py-1.5 align-top" : "px-1.5 py-1.5 align-top"}>
                          {week
                            .filter((c) => c.date === d && c.periodNr === p)
                            .map((c) => {
                              const cell = (
                                <span
                                  data-status={c.status}
                                  className={cn(
                                    "flex h-full flex-col gap-0.5 rounded-lg border border-border px-2 py-1.5",
                                    c.status === "missing" && "border-warn-border bg-warn-soft",
                                    c.status === "future" && "opacity-60",
                                  )}
                                >
                                  <span className={cn("font-medium", c.status === "cancelled" && "text-muted line-through")}>
                                    {c.subjectName} <span className="font-normal text-muted">{c.change?.kind === "substitute" ? c.change.substituteCode : c.teacherCode}</span>
                                  </span>
                                  <span className={cn("text-xs [overflow-wrap:anywhere]", c.status === "missing" ? "font-semibold text-warn" : "text-muted")}>
                                    {c.status === "done" ? c.entry!.topic : c.status === "missing" ? "Eintrag fehlt" : c.status === "cancelled" ? "Entfall" : ""}
                                  </span>
                                </span>
                              );
                              return c.status === "done" ? (
                                <Link key={c.lessonId} href={`/klassenbuch/eintrag?stunde=${c.lessonId}&datum=${c.date}`} className="block hover:opacity-80">
                                  {cell}
                                </Link>
                              ) : (
                                <span key={c.lessonId}>{cell}</span>
                              );
                            })}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="fehlzeiten" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="fehlzeiten" className="font-display text-xl font-bold">
                Fehlzeiten
              </h2>
              <nav aria-label="Zeitraum" className="flex gap-1 rounded-xl border border-border bg-surface p-1">
                {(
                  [
                    ["monat", "Dieser Monat"],
                    ["schuljahr", "Schuljahr"],
                  ] as const
                ).map(([key, label]) => (
                  <Link
                    key={key}
                    href={href({ zeitraum: key })}
                    aria-current={range === key ? "page" : undefined}
                    className={cn("flex h-8 items-center rounded-lg px-3 text-sm text-muted", range === key && "bg-accent-soft font-semibold text-accent-ink")}
                  >
                    {label}
                  </Link>
                ))}
              </nav>
            </div>
            <Table>
              <thead>
                <tr>
                  <th>Schüler:in</th>
                  <th className="text-right">Fehlstunden</th>
                  <th className="text-right">entschuldigt</th>
                  <th className="text-right">unentschuldigt</th>
                  <th className="text-right">offen</th>
                  <th className="text-right">Verspätungen</th>
                </tr>
              </thead>
              <tbody>
                {sums.map((s) => (
                  <tr key={s.studentId}>
                    <td className="font-medium whitespace-nowrap">{s.name}</td>
                    <td className={cn("text-right tabular-nums", s.absent > 0 ? "font-semibold" : "text-muted")}>{s.absent}</td>
                    <td className="text-right text-muted tabular-nums">{s.excused}</td>
                    <td className={cn("text-right tabular-nums", s.unexcused > 0 ? "font-semibold text-danger" : "text-muted")}>{s.unexcused}</td>
                    <td className={cn("text-right tabular-nums", s.open > 0 ? "font-semibold text-warn" : "text-muted")}>{s.open}</td>
                    <td className="text-right text-muted tabular-nums">{s.lateCount > 0 ? `${s.lateCount}× (${s.lateMinutes} Min.)` : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </main>
  );
}
