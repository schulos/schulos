import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { hasPermission } from "@/core/permissions";
import { previewAssignmentCsvAction, runAssignmentCsvAction } from "@/modules/stundenplan/actions";
import { planningYearForPage } from "../../planungsjahr";
import { ASSIGNMENT_CSV_HEADER } from "@/modules/stundenplan/verteilung-import";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { EmptyState, PageHeader } from "@schulos/ui/misc";
import { AssignmentImportForm } from "./import-form";

export const metadata: Metadata = { title: "Unterrichtsverteilung importieren" };

/**
 * SP2-06 (Q-SP-14): Lehraufträge aus einer CSV-Datei – Vorschau mit Fehlern je Zeile, Übernehmen nur ohne Fehler. SP3-09a: ins gewählte
 * Planungsjahr (auch das Folgejahr); abgeschlossene Schuljahre nur lesbar.
 */
export default async function AssignmentImportPage({ searchParams }: { searchParams: Promise<{ jahr?: string }> }) {
  const { perms } = await requireUser();
  if (!hasPermission(perms, "stundenplan.manage")) notFound();
  const py = await planningYearForPage(await getDb(), "/planung/unterricht/import", await searchParams);
  const year = py?.year ?? null;
  return (
    <main className="flex flex-col gap-6">
      <Link href="/planung/unterricht" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" /> Unterrichtsverteilung
      </Link>
      <PageHeader
        eyebrow="Stundenplanung"
        title="Unterrichtsverteilung importieren"
        actions={
          <Button asChild>
            <a href="/api/stundenplan/verteilung-vorlage" download>
              <Download aria-hidden /> Vorlage (CSV)
            </a>
          </Button>
        }
      />
      {!year ? (
        <EmptyState title="Kein Schuljahr angelegt">Lege unter Stammdaten → Schuljahre zuerst ein Schuljahr an.</EmptyState>
      ) : !py?.writable ? (
        <EmptyState title={`Schuljahr ${year.name} abgeschlossen`}>Abgeschlossene Schuljahre sind nur lesbar – im Kopf ein laufendes oder künftiges Schuljahr wählen.</EmptyState>
      ) : (
        <>
          <Card aria-labelledby="hinweise">
            <h2 id="hinweise" className="text-base font-semibold">
              So sieht die Datei aus
            </h2>
            <p className="text-sm text-muted">
              Eine Zeile je Lehrauftrag für das Schuljahr {year.name}. Spalten: <strong>{ASSIGNMENT_CSV_HEADER.join(" ; ")}</strong> – die Kopfzeile ist
              optional, die letzten fünf Spalten auch.
            </p>
            <ul className="list-disc pl-5 text-sm text-muted">
              <li>Klasse/Kurs, Fach, Lehrkraft und Raum über Kürzel oder Namen; zwei Lehrkräfte (Teamteaching) mit „/“ trennen, leer = noch offen.</li>
              <li>Gibt es den Lehrauftrag schon (gleiche Gruppe, gleiches Fach, eine gleiche Lehrkraft), wird er geändert; leere Spalten Doppelstunden/Raumwunsch lassen ihn wie er ist.</li>
              <li>Band: Name eines vorhandenen Bands (die Stunden müssen passen) oder eines neuen; Lehraufträge bleiben in ihrem bisherigen Band.</li>
              <li>
                „gültig ab“ / „gültig bis“ (JJJJ-MM-TT oder TT.MM.JJJJ, innerhalb des Schuljahrs): leer = ganzjährig. Ein Lehrauftrag mit anderem Zeitraum bei gleicher Gruppe, gleichem Fach und gleicher
                Lehrkraft entsteht neu, solange sich die Zeiträume nicht überschneiden; vorhandene Zeiträume ändert der Import nicht.
              </li>
              <li>Nur Lehraufträge – Stunden im Stundenplan entstehen erst beim Planen. Mit Fehlern wird nichts übernommen.</li>
            </ul>
          </Card>
          <AssignmentImportForm key={year.id} preview={previewAssignmentCsvAction.bind(null, year.id)} run={runAssignmentCsvAction.bind(null, year.id)} />
        </>
      )}
    </main>
  );
}
