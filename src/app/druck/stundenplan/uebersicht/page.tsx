import { requireModulePage } from "@/core/modules/guard";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { TZ, fromBerlinLocal, toBerlinDate } from "@/core/time";
import { buildExport, canExport, isExportArt } from "@/modules/stundenplan/exporte";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Übersicht drucken" };

const shortDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });

/**
 * SP2-10: Druckansicht der Gesamtübersichten, Unterrichtsverteilung, Deputate, des Aufsichtsplans und der Vertretungsstatistik
 * (A4 quer). Dieselbe Tabelle wie die CSV (`/api/stundenplan/export/<art>`); Rechte je Art in `canExport`.
 */
export default async function UebersichtDruckPage({ searchParams }: { searchParams: Promise<{ art?: string; zeitraum?: string }> }) {
  await requireModulePage("stundenplan");
  const { perms } = await requireUser();
  const sp = await searchParams;
  const art = sp.art ?? "";
  if (!isExportArt(art) || !canExport(art, perms)) notFound();
  const today = toBerlinDate(new Date());
  const monat = sp.zeitraum === "monat";
  const table = await buildExport(await getDb(), art, { today, monat });
  const dense = table.head.length > 12;
  const csv = `/api/stundenplan/export/${art}${monat ? "?zeitraum=monat" : ""}`;
  const back = art.startsWith("statistik")
    ? "/planung/vertretungen/statistik"
    : art === "aufsichten"
      ? "/planung/aufsichten"
      : art === "verteilung" || art === "deputate"
        ? "/planung/unterricht"
        : "/stundenplan";

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{"@media print { @page { size: A4 landscape; margin: 10mm; } }"}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={back}>Zurück</Link>
        </Button>
        <Button asChild variant="secondary" size="sm">
          <a href={csv} download>
            CSV herunterladen
          </a>
        </Button>
        <PrintButton />
      </nav>
      <main className="mx-auto flex max-w-[277mm] flex-col gap-3">
        <DruckKopf title={table.title} subtitle={table.subtitle} stamp={`gedruckt am ${shortDate.format(fromBerlinLocal(today))}`} />
        {table.rows.length === 0 ? (
          <p className="text-sm">Keine Einträge.</p>
        ) : (
          <table className={dense ? "w-full table-fixed border-collapse break-words text-[6.5pt] leading-tight" : "w-full border-collapse text-sm"}>
            <caption className="sr-only">
              {table.title} – {table.subtitle}
            </caption>
            <thead>
              <tr>
                {table.head.map((h, i) => (
                  <th key={`${h}-${i}`} scope="col" className={`border border-border-strong px-1 py-0.5 text-left ${dense && i === 0 ? "w-[14mm]" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, ri) => (
                <tr key={ri} className="break-inside-avoid">
                  {r.map((c, ci) => (
                    <td key={ci} className={`border border-border-strong px-0.5 py-0.5 align-top ${ci === 0 ? "font-semibold" : ""}`}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
