import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { canEvaluate, evaluation, monthLabel } from "@/modules/ganztag/auswertung";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";

export const metadata: Metadata = { title: "Ganztag: Auswertung" };

const fmt = (ymd: string) => ymd.split("-").reverse().join(".");

/** GT-06: „offen heute“ und Auswertung je Angebot und Monat – ohne Namen von Schüler:innen (`ganztag.view_all`). */
export default async function AuswertungPage() {
  const { perms } = await requireUser();
  if (!canEvaluate(perms)) notFound();
  const e = await evaluation(await getDb(), perms);

  return (
    <main className="flex max-w-5xl flex-col gap-6">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/ganztag">
          <ArrowLeft aria-hidden /> Ganztag
        </Link>
      </Button>
      <PageHeader
        eyebrow="Ganztag"
        title="Auswertung"
        actions={
          <Button asChild>
            <a href="/api/ganztag/auswertung" download>
              <Download aria-hidden /> CSV herunterladen
            </a>
          </Button>
        }
      />
      <p className="text-muted">
        Schuljahr bis heute ({fmt(e.from)} bis {fmt(e.to)}): Termine, Ausfälle und Teilnahme je Angebot und Monat – nur Zahlen, keine Namen von Schüler:innen.
      </p>

      <Card className="gap-3">
        <h2 className="text-lg font-semibold">Offen heute</h2>
        {e.openToday.length === 0 ? (
          <p className="text-sm text-muted">Alle heutigen Listen sind erfasst oder es gibt heute keine Termine.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Offen heute">
            {e.openToday.map((o) => (
              <li key={o.sessionId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3">
                <span className="flex flex-col">
                  <span className="font-medium">{o.offer}</span>
                  <span className="text-xs text-muted">
                    {o.startsAt}–{o.endsAt} Uhr{o.leaders.length > 0 && ` · ${o.leaders.join(", ")}`}
                  </span>
                </span>
                <Badge tone="warn">nicht erfasst</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <section aria-labelledby="monate" className="flex flex-col gap-3">
        <h2 id="monate" className="font-display text-xl font-bold">
          Je Angebot und Monat
        </h2>
        {e.rows.length === 0 ? (
          <EmptyState title="Noch keine Termine in diesem Schuljahr" />
        ) : (
          <Table scrollLabel="Auswertung je Angebot und Monat">
            <thead>
              <tr>
                <th scope="col">Angebot</th>
                <th scope="col">Monat</th>
                <th scope="col">Termine</th>
                <th scope="col">ausgefallen</th>
                <th scope="col">nicht erfasst</th>
                <th scope="col">Teilnehmertage</th>
                <th scope="col">gefehlt (entschuldigt)</th>
                <th scope="col">Quote</th>
              </tr>
            </thead>
            <tbody>
              {e.rows.map((r) => (
                <tr key={`${r.groupId}-${r.month}`}>
                  <td className="font-medium">{r.offer}</td>
                  <td>{monthLabel(r.month)}</td>
                  <td>{r.sessions}</td>
                  <td>{r.cancelled}</td>
                  <td>{r.open}</td>
                  <td>{r.present}</td>
                  <td>
                    {r.absent} ({r.absentExcused})
                  </td>
                  <td>{r.rate === null ? "–" : `${r.rate} %`}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
