import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { SCALE_LABELS } from "@/modules/notenbuch/berechnung";
import { notenbuchPageLocked } from "@/modules/notenbuch/guard";
import { offlineDecision } from "@/modules/notenbuch/offline";
import { examOptions, getBook, notenbuchAccess, ownAbsenceCounts } from "@/modules/notenbuch/service";
import { Badge } from "@schulos/ui/badge";
import { Button } from "@schulos/ui/button";
import { Card } from "@schulos/ui/card";
import { PageHeader } from "@schulos/ui/misc";
import { NotenbuchLocked } from "../gesperrt";
import { TermClose } from "./abschluss";
import { ColumnManager, WeightsForm } from "./spalten";
import { GradeTable, type TableCell, type TableColumn } from "./tabelle";

export const metadata: Metadata = { title: "Notenbuch" };
export const dynamic = "force-dynamic";

/**
 * Notentabelle (P5-12): nur für die Lehrkräfte des Buchs – fremde oder unbekannte Bücher 404 (auch Klassen-/Schulleitung,
 * Admin). Seite und Antworten ohne Zwischenspeicher (`src/core/no-store.ts`), Sperre nach Inaktivität (Layout + hier).
 */
export default async function NotenbuchBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { perms } = await requireUser();
  const db = await getDb();
  if (!(await notenbuchAccess(db, perms)).any) notFound(); // Schüler-/Elternsicht (P5-14) nur unter /notenbuch
  const gate = await notenbuchPageLocked(db, perms.userId);
  if (gate) return <NotenbuchLocked reason={gate} />;
  const view = await getBook(db, perms, decodeURIComponent((await params).id));
  if (!view) notFound();
  const { book } = view;
  // P5-20: Offline-Eingabe nur auf Dienstgeräten – Entscheidung für genau diese Anfrage (Zone, Gerätezertifikat, Einstellung)
  const [absences, exams, offline] = await Promise.all([ownAbsenceCounts(db, perms, book), examOptions(db, perms, book.id), offlineDecision(db, perms, await headers())]);
  // P5-15: Bücher eines vergangenen Schuljahres (nach dem Schuljahreswechsel) sind nur noch lesbar
  const locked = book.lockedAt !== null || view.pastYear;
  const pastNote = `Notenbuch aus dem Schuljahr ${view.schoolYearName} – nach dem Schuljahreswechsel nur noch lesbar. Es wird nicht ins neue Schuljahr übernommen und ein Jahr nach Schuljahresende gelöscht.`;

  const columns: TableColumn[] = view.columns.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    date: c.date,
    weight: c.weight,
    maxPoints: c.maxPoints,
    key: c.pointsToGrade ?? null,
  }));
  const entries: Record<string, TableCell> = Object.fromEntries(view.entries);
  const counts: Record<string, number> = {};
  for (const k of view.entries.keys()) {
    const col = k.slice(0, k.indexOf(":"));
    counts[col] = (counts[col] ?? 0) + 1;
  }
  // nach jeder Spalten-/Gewichtsänderung frisch aufbauen (Entwürfe der Tabelle hängen an diesem Stand)
  const finals: Record<string, string | null> = Object.fromEntries(view.students.map((s) => [s.id, view.termGrades.get(s.id)?.final ?? null]));
  const open = view.students.filter((s) => !finals[s.id]).length;
  const tableKey = JSON.stringify([book.weights, book.lockedAt, columns.map((c) => [c.id, c.weight, c.maxPoints, c.key, c.kind]), finals]);
  const lockedAt = book.lockedAt ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(book.lockedAt) : null;

  return (
    <main className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${view.schoolYearName} · ${book.term}. Halbjahr · ${SCALE_LABELS[book.scale]}`}
        title={`${view.groupName} – ${view.subjectName}`}
        actions={
          <Button asChild size="sm" variant="ghost">
            <Link href="/notenbuch" prefetch={false}>
              Alle Notenbücher
            </Link>
          </Button>
        }
      />
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        Geführt von {view.teachers.map((t) => t.name).join(", ")}
        {book.lockedAt && <Badge>abgeschlossen</Badge>}
        {view.pastYear && <Badge tone="soft">Vorjahr – nur lesbar</Badge>}
      </p>
      <GradeTable
        key={tableKey}
        bookId={book.id}
        userId={perms.userId}
        finals={finals}
        scale={book.scale}
        weights={book.weights}
        rounding={view.rounding}
        locked={locked}
        columns={columns}
        students={view.students}
        entries={entries}
        absences={Object.fromEntries(absences)}
        offline={offline}
        lockedNote={view.pastYear ? pastNote : undefined}
      />
      <Card aria-labelledby="abschluss">
        <h2 id="abschluss" className="text-base font-semibold">
          Halbjahresabschluss
        </h2>
        {view.pastYear && !book.lockedAt ? (
          <p className="text-sm text-muted">Nicht abgeschlossen. {pastNote}</p>
        ) : (
          <TermClose bookId={book.id} open={open} total={view.students.length} locked={locked} lockedAt={lockedAt} />
        )}
      </Card>
      <Card aria-labelledby="spalten">
        <h2 id="spalten" className="text-base font-semibold">
          Spalten
        </h2>
        <ColumnManager bookId={book.id} scale={book.scale} columns={columns} exams={exams} counts={counts} locked={locked} />
      </Card>
      <Card aria-labelledby="gewichtung">
        <h2 id="gewichtung" className="text-base font-semibold">
          Gewichtung
        </h2>
        <WeightsForm key={JSON.stringify(book.weights)} bookId={book.id} weights={book.weights} locked={locked} />
      </Card>
    </main>
  );
}
