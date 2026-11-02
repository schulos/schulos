import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { getSchoolSettings } from "@/core/settings";
import { toBerlinDate } from "@/core/time";
import { formatLoanDay, loanContract } from "@/modules/gebaeude/leihe";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { DruckKopf } from "@/ui/druck-kopf";

export const metadata: Metadata = { title: "Leihvertrag drucken" };

/**
 * INV-05: Leihvertrag als Druckansicht (auch „als PDF speichern“) – nur für Pflegende der Kategorie des Geräts, sonst 404. Wird nicht
 * gespeichert (Personenbezug nur in der Ausleihe, LK-ENDE-1J); die unterschriebene Fassung verwahrt die Schule auf Papier. Die
 * Bedingungen sind eine allgemeine Vorlage – Haftung und Ersatz regelt die Schule bzw. der Schulträger (Feld „Besondere Vereinbarungen“).
 */
export default async function LeihvertragDruckPage({ params }: { params: Promise<{ id: string }> }) {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  const { id } = await params;
  const school = await getSchoolSettings();
  const c = await loanContract(await getDb(), perms, decodeURIComponent(id), school.name);
  if (!c) notFound();
  const device = [c.assetName, [c.manufacturer, c.model].filter(Boolean).join(" ")].filter(Boolean).join(" – ");
  const row = (label: string, value: React.ReactNode) => (
    <tr className="border-b border-border">
      <th scope="row" className="w-[55mm] py-1 pr-4 align-top font-medium">
        {label}
      </th>
      <td className="py-1">{value}</td>
    </tr>
  );

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{"@media print { @page { size: A4 portrait; margin: 18mm 18mm 18mm 22mm; } }"}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href="/gebaeude/leihen">Zurück</Link>
        </Button>
        <PrintButton />
        {c.returned && <span className="text-sm text-muted">Diese Ausleihe ist schon zurückgegeben.</span>}
      </nav>
      <main aria-label="Leihvertrag" className="mx-auto flex max-w-[170mm] flex-col gap-4 text-[10.5pt] leading-relaxed">
        <DruckKopf eyebrow="Gebäude & Technik" title="Leihvertrag" subtitle="Überlassung eines Leihgeräts der Schule" stamp={`gedruckt am ${formatLoanDay(toBerlinDate(new Date()))}`} />
        <p>
          Zwischen der Schule <strong>{c.school}</strong> (Verleiherin) und der unten genannten Person (Entleihende{c.minor ? ", vertreten durch die Erziehungsberechtigten" : ""}) wird
          folgender Leihvertrag geschlossen:
        </p>
        <table className="w-full border-collapse text-left">
          <tbody>
            {row("Entleihende Person", c.borrower ?? "–")}
            {c.className && row("Klasse", c.className)}
            {row("Gerät", device)}
            {row("Kategorie", c.categoryName)}
            {row("Inventarnummer", c.inventoryNo ?? "–")}
            {c.serial && row("Seriennummer", c.serial)}
            {row("Zubehör", c.accessories ?? "–")}
            {row("Ausgegeben am", formatLoanDay(c.loanedOn))}
            {row("Rückgabe spätestens am", <strong>{formatLoanDay(c.dueOn)}</strong>)}
          </tbody>
        </table>
        <section aria-labelledby="bedingungen" className="flex flex-col gap-1">
          <h2 id="bedingungen" className="text-base font-bold">
            Bedingungen
          </h2>
          <ol className="list-decimal pl-5">
            <li>Das Gerät bleibt Eigentum der Schule bzw. des Schulträgers. Es wird für schulische Zwecke überlassen und darf nicht an andere weitergegeben werden.</li>
            <li>Das Gerät und das Zubehör sind pfleglich zu behandeln und vor Verlust, Diebstahl und Beschädigung zu schützen.</li>
            <li>Schäden, Störungen und Verlust sind der Schule unverzüglich zu melden. Eigene Reparaturen oder Veränderungen an Gerät und Software sind nicht erlaubt.</li>
            <li>Das Gerät ist mit Zubehör spätestens zum oben genannten Datum zurückzugeben, auf Verlangen der Schule auch früher (z. B. beim Verlassen der Schule).</li>
            <li>Für Schäden durch unsachgemäßen Gebrauch, Verlust oder verspätete Rückgabe gelten die Regeln der Schule bzw. des Schulträgers und die gesetzlichen Vorschriften.</li>
            <li>Gespeicherte eigene Daten sind vor der Rückgabe zu löschen; die Schule setzt das Gerät nach der Rückgabe zurück.</li>
          </ol>
        </section>
        <section aria-labelledby="besonders" className="flex flex-col gap-1">
          <h2 id="besonders" className="text-base font-bold">
            Besondere Vereinbarungen
          </h2>
          <div className="h-16 border-b border-border-strong" />
          <div className="h-6 border-b border-border-strong" />
        </section>
        <p className="text-xs">
          Datenschutz: Die Schule speichert, wer welches Gerät bis wann ausgeliehen hat, und erinnert vor und nach dem Rückgabedatum. Die Angaben werden ein Jahr nach der Rückgabe gelöscht;
          dieser Vertrag wird nicht elektronisch gespeichert.
        </p>
        <div className="mt-8 grid grid-cols-1 gap-8 text-xs sm:grid-cols-2 print:grid-cols-2">
          <p className="border-t border-border-strong pt-1">Ort, Datum, Unterschrift für die Schule</p>
          <p className="border-t border-border-strong pt-1">Ort, Datum, Unterschrift entleihende Person</p>
          {c.minor && <p className="border-t border-border-strong pt-1">Ort, Datum, Unterschrift Erziehungsberechtigte</p>}
        </div>
        <section aria-labelledby="rueckgabe" className="mt-4 flex flex-col gap-2 border-t-2 border-ink pt-2">
          <h2 id="rueckgabe" className="text-base font-bold">
            Rückgabe
          </h2>
          <p>Gerät mit Zubehör zurückerhalten am ______________ · Zustand / Befund: ____________________________________</p>
          <p className="mt-6 w-1/2 border-t border-border-strong pt-1 text-xs">Unterschrift für die Schule</p>
        </section>
        <p className="text-xs">Erstellt mit SchulOS.</p>
      </main>
    </div>
  );
}
