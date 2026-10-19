import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { toBerlinDate } from "@/core/time";
import { CONDITION_LABELS, MEDIA_TYPE_LABELS, MEDIA_TYPES, type CopyCondition } from "@/modules/buecherei/labels";
import { canStats, loanStatistics, neverLoaned, stockStatistics, withdrawalSuggestions, type Suggestion } from "@/modules/buecherei/statistik";
import { Button } from "@schulos/ui/button";
import { Card, CardHeader } from "@schulos/ui/card";
import { Field, Select } from "@schulos/ui/field";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { BuechereiNav } from "../ui";

export const metadata: Metadata = { title: "Bücherei-Statistik" };

const YEAR_CHOICES = [2, 3, 5] as const;
const monthFmt = new Intl.DateTimeFormat("de-DE", { month: "short", year: "numeric", timeZone: "UTC" });
const monthLabel = (ym: string) => monthFmt.format(new Date(`${ym}-01T00:00:00Z`));
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

function reasonText(s: Suggestion, years: number): string {
  if (s.reason === "zustand") return `Zustand ${CONDITION_LABELS[s.condition as CopyCondition] ?? s.condition}`;
  if (s.reason === "nie") return `seit über ${years} Jahren im Bestand, nie ausgeliehen`;
  return `zuletzt ausgeliehen ${s.lastLoanMonth ? monthLabel(s.lastLoanMonth) : "–"}`;
}

/**
 * Statistik der Bücherei (BU-05, Recht `buecherei.stock`) – ohne Personenbezug: Ausleihen je Monat und Medienart aus den
 * Zählern, Bestand je Medienart, nie ausgeliehene Titel und Aussonderungsvorschläge (Nutzung je Exemplar, ohne Person).
 */
export default async function StatistikPage({ searchParams }: { searchParams: Promise<{ jahre?: string }> }) {
  const { perms } = await requireUser();
  if (!canStats(perms)) notFound();
  const sp = await searchParams;
  const years = YEAR_CHOICES.find((y) => String(y) === sp.jahre) ?? 3;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const [loans, stock, never, suggestions] = await Promise.all([
    loanStatistics(db, perms, today),
    stockStatistics(db, perms),
    neverLoaned(db, perms),
    withdrawalSuggestions(db, perms, today, years),
  ]);
  // nur Medienarten mit Bestand oder Ausleihen als Spalten
  const types = MEDIA_TYPES.filter((m) => loans.totals.loans[m] > 0 || stock.some((s) => s.mediaType === m));

  return (
    <main className="flex flex-col gap-6">
      <PageHeader eyebrow="Bücherei" title="Statistik" />
      <BuechereiNav current="statistik" perms={perms} />
      <p className="max-w-3xl text-sm text-muted">
        Alle Zahlen ohne Personenbezug: Die Bücherei zählt Ausleihen, Verlängerungen und Mahnungen nur je Monat und Medienart und je Exemplar nur, wie oft und in
        welchem Monat zuletzt es ausgeliehen wurde – wer etwas gelesen hat, lässt sich nicht auswerten.
      </p>

      <Card aria-labelledby="monate">
        <CardHeader title={<span id="monate">Ausleihen der letzten 12 Monate</span>} />
        <Table>
          <caption className="sr-only">Ausleihen je Monat und Medienart</caption>
          <thead>
            <tr>
              <th>Monat</th>
              {types.map((m) => (
                <th key={m} className="text-right">
                  {MEDIA_TYPE_LABELS[m]}
                </th>
              ))}
              <th className="text-right">Ausleihen</th>
              <th className="hidden sm:table-cell">
                <span className="sr-only">Verlauf</span>
              </th>
              <th className="text-right">Verlängerungen</th>
              <th className="text-right">Mahnungen</th>
            </tr>
          </thead>
          <tbody>
            {loans.months.map((r) => (
              <tr key={r.month}>
                <td className="whitespace-nowrap">{monthLabel(r.month)}</td>
                {types.map((m) => (
                  <td key={m} className="text-right tabular-nums">
                    {r.loans[m] || "–"}
                  </td>
                ))}
                <td className="text-right font-semibold tabular-nums">{r.total}</td>
                <td className="hidden w-40 sm:table-cell" aria-hidden>
                  <div className="h-2 rounded-full bg-accent" style={{ width: `${loans.max ? Math.round((r.total / loans.max) * 100) : 0}%` }} />
                </td>
                <td className="text-right tabular-nums">{r.renewals || "–"}</td>
                <td className="text-right tabular-nums">{r.dunnings || "–"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td>Summe</td>
              {types.map((m) => (
                <td key={m} className="text-right tabular-nums">
                  {loans.totals.loans[m]}
                </td>
              ))}
              <td className="text-right tabular-nums">{loans.totals.total}</td>
              <td className="hidden sm:table-cell" />
              <td className="text-right tabular-nums">{loans.totals.renewals}</td>
              <td className="text-right tabular-nums">{loans.totals.dunnings}</td>
            </tr>
          </tfoot>
        </Table>
      </Card>

      <Card aria-labelledby="bestand">
        <CardHeader title={<span id="bestand">Bestand je Medienart</span>} />
        {stock.length === 0 ? (
          <EmptyState title="Noch kein Bestand" />
        ) : (
          <Table>
            <caption className="sr-only">Bestand je Medienart</caption>
            <thead>
              <tr>
                <th>Medienart</th>
                <th className="text-right">Titel</th>
                <th className="text-right">Exemplare</th>
                <th className="text-right">davon ausgeliehen</th>
                <th className="text-right">nie ausgeliehen</th>
                <th className="text-right">ausgesondert</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((s) => (
                <tr key={s.mediaType}>
                  <td>{MEDIA_TYPE_LABELS[s.mediaType]}</td>
                  <td className="text-right tabular-nums">{s.titles}</td>
                  <td className="text-right tabular-nums">{s.active}</td>
                  <td className="text-right tabular-nums">{s.loaned}</td>
                  <td className="text-right tabular-nums">{s.never}</td>
                  <td className="text-right tabular-nums">{s.withdrawn}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card aria-labelledby="nie">
        <CardHeader title={<span id="nie">Nie ausgeliehen</span>} />
        <p className="text-sm text-muted">Titel, von denen noch kein Exemplar im Bestand ausgeliehen wurde (gezählt seit Einführung der Statistik).</p>
        {never.length === 0 ? (
          <EmptyState title="Jeder Titel wurde schon ausgeliehen" />
        ) : (
          <Table>
            <caption className="sr-only">Nie ausgeliehene Titel</caption>
            <thead>
              <tr>
                <th>Titel</th>
                <th>Medienart</th>
                <th className="text-right">Exemplare</th>
                <th>im Bestand seit</th>
              </tr>
            </thead>
            <tbody>
              {never.map((t) => (
                <tr key={t.titleId}>
                  <td>
                    <Link href={`/buecherei/bestand/${t.titleId}`} className="font-medium text-accent-ink hover:underline">
                      {t.title}
                    </Link>
                    {t.author && <span className="block text-xs text-muted">{t.author}</span>}
                  </td>
                  <td>{MEDIA_TYPE_LABELS[t.mediaType]}</td>
                  <td className="text-right tabular-nums">{t.copies}</td>
                  <td className="tabular-nums">{day(t.since)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card aria-labelledby="aussondern">
        <CardHeader title={<span id="aussondern">Aussonderungsvorschläge</span>} />
        <p className="text-sm text-muted">
          Exemplare im Regal in schlechtem Zustand oder lange nicht ausgeliehen. Nur Vorschläge – ausgesondert wird im Bestand beim Titel.
        </p>
        <form aria-label="Zeitraum der Vorschläge" className="flex flex-wrap items-end gap-3">
          <Field label="nicht ausgeliehen seit">
            <Select name="jahre" defaultValue={String(years)} className="w-40">
              {YEAR_CHOICES.map((y) => (
                <option key={y} value={y}>
                  {y} Jahren
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary">
            Anzeigen
          </Button>
        </form>
        {suggestions.length === 0 ? (
          <EmptyState title="Keine Vorschläge" />
        ) : (
          <Table>
            <caption className="sr-only">Aussonderungsvorschläge</caption>
            <thead>
              <tr>
                <th>Exemplar</th>
                <th>Titel</th>
                <th>Grund</th>
                <th className="text-right">Ausleihen</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => (
                <tr key={s.copyId}>
                  <td className="font-mono tabular-nums">{s.barcode}</td>
                  <td>
                    <Link href={`/buecherei/bestand/${s.titleId}`} className="font-medium text-accent-ink hover:underline">
                      {s.title}
                    </Link>
                  </td>
                  <td>{reasonText(s, years)}</td>
                  <td className="text-right tabular-nums">{s.loanCount}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
