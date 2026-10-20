import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { getSchoolSettings } from "@/core/settings";
import { BooklistView } from "@/modules/buecherei/booklist-view";
import { booklist, canReadBooklist, lernmittelEnabled } from "@/modules/buecherei/lernmittel";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Bücherliste drucken" };

/**
 * Bücherliste eines Jahrgangs drucken (BU-10) – zum Mitgeben oder als Anhang eines Elternbriefs. Gleiche Sichtbarkeit wie die
 * Seite (Entwürfe nur für die Pflege), Druck über den Browser.
 */
export default async function BuecherlisteDruckPage({ searchParams }: { searchParams: Promise<{ jahrgang?: string }> }) {
  await requireModulePage("buecherei");
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canReadBooklist(perms) || !(await lernmittelEnabled(db))) notFound();
  const grade = Number((await searchParams).jahrgang);
  const list = Number.isInteger(grade) ? await booklist(db, perms, grade) : null;
  if (!list) notFound();
  const school = await getSchoolSettings();
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{"@media print { @page { size: A4 portrait; margin: 15mm; } }"}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/buecherei/buecherliste?jahrgang=${list.grade}`}>Zurück</Link>
        </Button>
        <PrintButton />
        {!list.published && <span className="text-sm text-muted">Entwurf – noch nicht für Eltern freigegeben</span>}
      </nav>
      <main aria-label={`Bücherliste ${list.gradeName}`} className="mx-auto flex max-w-[180mm] flex-col gap-4">
        <header>
          <p className="text-xs tracking-wide uppercase">{school.name}</p>
          <h1 className="text-xl font-bold">Bücherliste {list.gradeName}</h1>
        </header>
        <BooklistView list={list} />
      </main>
    </div>
  );
}
