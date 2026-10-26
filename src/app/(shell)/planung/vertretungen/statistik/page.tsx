import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { substitutionStats } from "@/modules/stundenplan/vorschlaege";
import { Button } from "@schulos/ui/button";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { Table } from "@schulos/ui/table";
import { ExportMenu } from "@/ui/export-menu";

export const metadata: Metadata = { title: "Vertretungsstatistik" };

const dateFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: TZ });
const fmt = (ymd: string) => dateFmt.format(fromBerlinLocal(ymd));

/** Vertretungsstatistik: Mehrarbeit je Lehrkraft, Vertretung/Entfall je Klasse – Schuljahr oder laufender Monat. */
export default async function VertretungsstatistikPage({ searchParams }: { searchParams: Promise<{ zeitraum?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.substitute")) notFound();
  const sp = await searchParams;
  const db = await getDb();
  const today = toBerlinDate(new Date());
  const year = await planningYear(db);
  const month = sp.zeitraum === "monat";
  const from = month ? `${today.slice(0, 8)}01` : (year?.startsOn ?? `${today.slice(0, 4)}-01-01`);
  const to = month ? today : (year?.endsOn ?? today);
  const stats = await substitutionStats(db, from, to);

  return (
    <main className="flex flex-col gap-6">
      <Link href="/planung/vertretungen" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Vertretungen
      </Link>
      <PageHeader eyebrow="Stundenplanung" title="Vertretungsstatistik" actions={<ExportMenu arts={["statistik-lehrkraefte", "statistik-klassen"]} perms={perms} zeitraum={sp.zeitraum} />} />
      <nav aria-label="Zeitraum" className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant={month ? "ghost" : "secondary"}>
          <Link href="/planung/vertretungen/statistik" aria-current={month ? undefined : "page"}>
            Schuljahr{year ? ` ${year.name}` : ""}
          </Link>
        </Button>
        <Button asChild size="sm" variant={month ? "secondary" : "ghost"}>
          <Link href="/planung/vertretungen/statistik?zeitraum=monat" aria-current={month ? "page" : undefined}>
            Dieser Monat
          </Link>
        </Button>
        <span className="text-sm text-muted">
          {fmt(from)} – {fmt(to)}
        </span>
      </nav>

      <section aria-labelledby="st-t" className="flex flex-col gap-3">
        <h2 id="st-t" className="font-display text-xl font-bold">
          Lehrkräfte
        </h2>
        {stats.teachers.length === 0 ? (
          <EmptyState title="Keine Vertretungen im Zeitraum" />
        ) : (
          <Table>
            <caption className="sr-only">Vertretungen je Lehrkraft</caption>
            <thead>
              <tr>
                <th>Lehrkraft</th>
                <th className="text-right" title="Mehrarbeit">
                  vertreten
                </th>
                <th className="text-right" title="Vertretung mit eigenem statt dem ausgefallenen Fach">
                  davon mit eigenem Fach
                </th>
                <th className="text-right">abgegeben</th>
                <th className="text-right">Entfall</th>
              </tr>
            </thead>
            <tbody>
              {stats.teachers.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="font-medium">{t.code ?? "–"}</span>
                    <span className="text-muted"> · {t.name}</span>
                  </td>
                  <td className="text-right font-semibold tabular-nums">{t.substitutions}</td>
                  <td className="text-right tabular-nums">{t.ownSubject}</td>
                  <td className="text-right tabular-nums">{t.given}</td>
                  <td className="text-right tabular-nums">{t.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="st-g" className="flex flex-col gap-3">
        <h2 id="st-g" className="font-display text-xl font-bold">
          Klassen und Kurse
        </h2>
        {stats.groups.length === 0 ? (
          <EmptyState title="Keine Änderungen im Zeitraum" />
        ) : (
          <Table>
            <caption className="sr-only">Vertretung und Entfall je Klasse</caption>
            <thead>
              <tr>
                <th>Klasse/Kurs</th>
                <th className="text-right">vertreten</th>
                <th className="text-right">davon mit anderem Fach</th>
                <th className="text-right">Entfall</th>
              </tr>
            </thead>
            <tbody>
              {stats.groups.map((g) => (
                <tr key={g.id}>
                  <td className="font-medium">{g.name}</td>
                  <td className="text-right tabular-nums">{g.substituted}</td>
                  <td className="text-right tabular-nums">{g.ownSubject}</td>
                  <td className="text-right tabular-nums">{g.cancelled}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </main>
  );
}
