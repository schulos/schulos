import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { CATEGORY_LABELS, TICKET_CATEGORIES } from "@/modules/gebaeude/labels";
import { ticketStats, canConfigure } from "@/modules/gebaeude/pruefungen";
import { canViewAll } from "@/modules/gebaeude/service";
import { Button } from "@schulos/ui/button";
import { PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { GebaeudeNav } from "../ui";

export const metadata: Metadata = { title: "Statistik Gebäude & Technik" };

const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (ym: string) => monthFmt.format(new Date(`${ym}-15T12:00:00Z`));

/** Meldungen je Monat und Kategorie (letzte 12 Monate) – ohne Personenbezug, keine Auswertung je Bearbeiter:in. */
export default async function StatistikPage() {
  const { perms } = await requireUser();
  if (!canViewAll(perms)) notFound();
  const stats = await ticketStats(await getDb(), perms, new Date());
  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Gebäude & Technik"
        title="Statistik"
        actions={
          <>
            <Button asChild>
              <a href="/api/gebaeude/export/meldungen" download>
                Meldungen (CSV)
              </a>
            </Button>
            <Button asChild>
              <a href="/api/gebaeude/export/pruefungen" download>
                Prüfungen (CSV)
              </a>
            </Button>
            <Button asChild>
              <Link href="/druck/pruefliste">Prüfliste drucken</Link>
            </Button>
          </>
        }
      />
      <GebaeudeNav current="statistik" configure={canConfigure(perms)} />
      <p className="text-sm text-muted">
        Nur je Kategorie und Monat – SchulOS wertet nicht aus, wer wie viel gemeldet oder bearbeitet hat. CSV-Exporte enthalten keine Namen und keine Beschreibungen.
      </p>
      <section aria-labelledby="kategorien" className="flex flex-col gap-3">
        <h2 id="kategorien" className="font-display text-xl font-bold">
          Je Kategorie (12 Monate, {stats.total} Meldungen)
        </h2>
        <Table>
          <caption className="sr-only">Meldungen je Kategorie</caption>
          <thead>
            <tr>
              <th>Kategorie</th>
              <th className="text-right">Meldungen</th>
              <th className="text-right">Ø Tage bis Abschluss</th>
            </tr>
          </thead>
          <tbody>
            {stats.categories.map((c) => (
              <tr key={c.category}>
                <td>{CATEGORY_LABELS[c.category]}</td>
                <td className="text-right tabular-nums">{c.count}</td>
                <td className="text-right tabular-nums">{c.avgDays === null ? "–" : c.avgDays.toLocaleString("de-DE")}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
      <section aria-labelledby="monate" className="flex flex-col gap-3">
        <h2 id="monate" className="font-display text-xl font-bold">
          Je Monat
        </h2>
        <Table>
          <caption className="sr-only">Meldungen je Monat und Kategorie</caption>
          <thead>
            <tr>
              <th>Monat</th>
              {TICKET_CATEGORIES.map((c) => (
                <th key={c} className="text-right">
                  {CATEGORY_LABELS[c]}
                </th>
              ))}
              <th className="text-right">Summe</th>
            </tr>
          </thead>
          <tbody>
            {stats.months.map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td>
                {TICKET_CATEGORIES.map((c) => (
                  <td key={c} className="text-right tabular-nums">
                    {m.counts[c] || "·"}
                  </td>
                ))}
                <td className="text-right font-semibold tabular-nums">{TICKET_CATEGORIES.reduce((n, c) => n + m.counts[c], 0)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </main>
  );
}
