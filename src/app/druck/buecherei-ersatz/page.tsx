import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { getSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import { compensationLetter } from "@/modules/buecherei/ersatz";
import { formatEuro } from "@/modules/buecherei/labels";
import { canMaterials, lernmittelEnabled } from "@/modules/buecherei/lernmittel";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Ersatzforderung drucken" };

const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const day = (ymd: string) => dayFmt.format(new Date(`${ymd}T00:00:00Z`));

/**
 * Brief zur Ersatzforderung (BU-12, Recht `buecherei.materials`, nur mit Schulbuchausleihe): an die Eltern Minderjähriger, sonst
 * an die Person. Druck über den Browser (auch „als PDF speichern“), kein PDF-Paket. Keine Bankverbindung, keine Zahlung in
 * SchulOS – wie bezahlt wird, sagt die Schule. Öffnen vermerkt „Brief gedruckt am“ (Audit).
 */
export default async function ErsatzDruckPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  await requireModulePage("buecherei");
  const { perms } = await requireUser();
  const db = await getDb();
  if (!canMaterials(perms) || !(await lernmittelEnabled(db))) notFound();
  const id = (await searchParams).id;
  const today = toBerlinDate(new Date());
  const letter = id ? await compensationLetter(db, perms, id, today) : null;
  if (!letter) notFound();
  const school = await getSchoolSettings();
  const subject = letter.toParents ? `Ersatz für ein Medium der Schulbücherei – ${letter.person}${letter.className ? `, Klasse ${letter.className}` : ""}` : "Ersatz für ein Medium der Schulbücherei";
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{"@media print { @page { size: A4 portrait; margin: 20mm 20mm 20mm 25mm; } }"}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/buecherei/ersatz">Zurück</Link>
        </Button>
        <PrintButton />
        {letter.status !== "offen" && <span className="text-sm text-muted">Forderung ist {letter.status}</span>}
      </nav>
      <main aria-label="Brief Ersatzforderung" className="mx-auto flex max-w-[165mm] flex-col gap-5 text-[11pt] leading-relaxed">
        <header className="flex flex-col gap-1">
          <p className="text-xs tracking-wide uppercase">{school.name} · Schulbücherei</p>
          <div className="mt-6">
            {letter.recipients.map((r) => (
              <p key={r}>{r}</p>
            ))}
          </div>
          <p className="mt-6 self-end">{day(today)}</p>
        </header>
        <h1 className="text-base font-bold">{subject}</h1>
        <p>{letter.toParents ? "Sehr geehrte Erziehungsberechtigte," : `Guten Tag ${letter.person},`}</p>
        <p>
          {letter.toParents ? "ein von Ihrem Kind ausgeliehenes Medium" : "ein von Ihnen ausgeliehenes Medium"} der Schulbücherei ist beschädigt zurückgekommen oder nicht zurückgegeben
          worden. Die Schule bittet um Ersatz:
        </p>
        <table className="w-full border-collapse text-left">
          <tbody>
            <tr className="border-b border-border">
              <th className="py-1 pr-4 font-medium">Medium</th>
              <td className="py-1">{letter.item}</td>
            </tr>
            <tr className="border-b border-border">
              <th className="py-1 pr-4 font-medium">Grund</th>
              <td className="py-1">{letter.reason}</td>
            </tr>
            <tr className="border-b border-border">
              <th className="py-1 pr-4 font-medium">Betrag</th>
              <td className="py-1 font-semibold">{formatEuro(letter.amountCents)}</td>
            </tr>
            <tr>
              <th className="py-1 pr-4 font-medium">festgestellt am</th>
              <td className="py-1">{day(letter.createdOn)}</td>
            </tr>
          </tbody>
        </table>
        <p>
          Statt des Betrags kann auch ein gleichwertiges neues Exemplar (gleicher Titel und gleiche Auflage) abgegeben werden. Wie der Betrag bezahlt wird, teilt
          Ihnen das Sekretariat mit. Bei Fragen oder wenn der Schaden nicht verschuldet ist, sprechen Sie uns bitte an.
        </p>
        <p>Mit freundlichen Grüßen</p>
        <p className="mt-8">{school.name}</p>
      </main>
    </div>
  );
}
