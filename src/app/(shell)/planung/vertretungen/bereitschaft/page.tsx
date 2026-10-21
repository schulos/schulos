import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { addStandbyAction, removeStandbyAction } from "@/modules/stundenplan/actions";
import { listStandby } from "@/modules/stundenplan/bereitschaft";
import { teacherOptions } from "@/modules/stundenplan/manage";
import { timetableMasterData } from "@/modules/stundenplan/service";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { StandbyForm } from "./standby-form";

export const metadata: Metadata = { title: "Bereitschaften" };

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];

/**
 * SP2-07 (SP-G-08): Bereitschaften – Vertretungsreserve je Wochentag und Stunde. Personaldienst: nur mit `stundenplan.substitute`.
 * Wer Bereitschaft hat, steht bei den Vertretungsvorschlägen dieser Stunde oben.
 */
export default async function BereitschaftPage() {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.substitute")) notFound();
  const db = await getDb();
  const year = await planningYear(db);
  const [entries, teachers, master] = await Promise.all([year ? listStandby(db, year.id) : Promise.resolve([]), teacherOptions(db), timetableMasterData(db)]);

  return (
    <main className="flex flex-col gap-6">
      <Link href="/planung/vertretungen" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Vertretungen
      </Link>
      <PageHeader eyebrow="Stundenplanung" title="Bereitschaften" />
      {year && <p className="-mt-4 text-sm text-muted">Vertretungsreserve im Schuljahr {year.name}</p>}
      {!year ? (
        <EmptyState title="Kein Schuljahr angelegt" />
      ) : (
        <>
          <Card className="gap-3">
            <h2 className="text-base font-semibold">Bereitschaft eintragen</h2>
            <p className="-mt-2 text-sm text-muted">
              Wer zu einer Stunde Bereitschaft hat, steht bei den Vertretungsvorschlägen dieser Stunde oben. Bereitschaften sieht nur die Vertretungsplanung.
            </p>
            <StandbyForm
              action={addStandbyAction}
              schoolYearId={year.id}
              teachers={teachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.name}` }))}
              weekdays={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
              periods={master.periods.map((p) => ({ value: String(p.nr), label: `${p.nr}. Stunde` }))}
            />
          </Card>
          <section aria-labelledby="standby-title" className="flex flex-col gap-3">
            <h2 id="standby-title" className="font-display text-xl font-bold">
              Wochenübersicht
            </h2>
            <Table>
              <caption className="sr-only">Bereitschaften je Wochentag und Stunde</caption>
              <thead>
                <tr>
                  <th>Std.</th>
                  {WEEKDAYS.map((d) => (
                    <th key={d}>{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {master.periods.map((p) => (
                  <tr key={p.nr}>
                    <td className="tabular-nums">{p.nr}.</td>
                    {WEEKDAYS.map((d, wd) => {
                      const here = entries.filter((e) => e.weekday === wd && e.periodNr === p.nr);
                      return (
                        <td key={d}>
                          <ul className="flex flex-wrap gap-1">
                            {here.map((e) => (
                              <li key={e.id} className="flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pr-0.5 pl-2 text-sm">
                                <span title={e.teacherName}>{e.teacherCode ?? e.teacherName}</span>
                                <form action={removeStandbyAction.bind(null, e.id)}>
                                  <Button type="submit" size="sm" variant="ghost" aria-label={`Bereitschaft ${e.teacherCode ?? e.teacherName} ${d} ${p.nr}. Std entfernen`}>
                                    ×
                                  </Button>
                                </form>
                              </li>
                            ))}
                          </ul>
                        </td>
                      );
                    })}
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
