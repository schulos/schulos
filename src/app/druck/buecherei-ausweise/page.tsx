import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { getSchoolSettings } from "@/core/settings";
import { cardsToPrint } from "@/modules/buecherei/cards";
import { canDesk } from "@/modules/buecherei/loans";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { Barcode } from "@/ui/barcode";

export const metadata: Metadata = { title: "Büchereiausweise drucken" };

type Search = { klasse?: string; person?: string; format?: string };

// Seitenformate: Karte = Scheckkartengröße (85,6 × 54 mm) zu zehnt auf A4 hoch; Etikett = eins je Seite für Etikettendrucker.
const PAGE_CSS = {
  karte: "@media print { @page { size: A4 portrait; margin: 10mm 9mm; } }",
  etikett: "@media print { @page { size: 62mm 29mm; margin: 0; } }",
} as const;

/**
 * Büchereiausweise drucken (BU-07, Recht `buecherei.desk`): Name, Klasse und der pseudonyme Code als Code 128. Druck über den
 * Browser (`@page` in mm), kein PDF-Paket. Personen ohne Code erscheinen nicht – Codes legt die Seite „Ausweise“ an.
 */
export default async function AusweisDruckPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModulePage("buecherei");
  const { perms } = await requireUser();
  if (!canDesk(perms)) notFound();
  const sp = await searchParams;
  const format = sp.format === "etikett" ? "etikett" : "karte";
  const data = await cardsToPrint(await getDb(), perms, { groupId: sp.klasse, userId: sp.klasse ? undefined : sp.person });
  if (!data) notFound();
  const cards = data.cards.filter((c) => c.code);
  const school = await getSchoolSettings();
  const back = sp.person && !sp.klasse ? `/buecherei/theke?person=${encodeURIComponent(sp.person)}` : "/buecherei/ausweise";
  const query = (f: string) => `?${new URLSearchParams({ ...(sp.klasse ? { klasse: sp.klasse } : { person: sp.person ?? "" }), format: f })}`;
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{PAGE_CSS[format]}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={back}>Zurück</Link>
        </Button>
        <Button asChild variant={format === "karte" ? "secondary" : "ghost"} size="sm">
          <Link href={query("karte")} aria-current={format === "karte" ? "page" : undefined}>
            Karten (A4)
          </Link>
        </Button>
        <Button asChild variant={format === "etikett" ? "secondary" : "ghost"} size="sm">
          <Link href={query("etikett")} aria-current={format === "etikett" ? "page" : undefined}>
            Etiketten 62 × 29 mm
          </Link>
        </Button>
        <PrintButton />
        <span className="text-sm text-muted">
          {data.title}: {cards.length} {cards.length === 1 ? "Ausweis" : "Ausweise"}
          {data.cards.length > cards.length && ` (${data.cards.length - cards.length} ohne Code – erst unter „Ausweise“ erzeugen)`}
        </span>
      </nav>
      {format === "karte" ? (
        <main aria-label="Ausweise" className="grid w-[190mm] grid-cols-2 gap-x-[2mm] gap-y-[1mm]">
          {cards.map((c) => (
            <section
              key={c.userId}
              aria-label={`Ausweis ${c.name}`}
              className="flex h-[54mm] w-[85.6mm] break-inside-avoid flex-col justify-between rounded-[3mm] border border-ink/40 p-[4mm]"
            >
              <div>
                <p className="text-[8pt] uppercase tracking-wide">{school.name} · Bücherei</p>
                <p className="mt-[1mm] text-[12pt] font-bold leading-tight">{c.name}</p>
                {c.className && <p className="text-[9pt]">Klasse {c.className}</p>}
              </div>
              <div className="flex flex-col items-center">
                <Barcode value={c.code!} widthMm={70} heightMm={14} />
                <p className="font-mono text-[9pt]">{c.code}</p>
              </div>
            </section>
          ))}
        </main>
      ) : (
        <main aria-label="Ausweise" className="flex flex-col gap-4 print:gap-0">
          {cards.map((c) => (
            <section key={c.userId} aria-label={`Ausweis ${c.name}`} className="flex h-[29mm] w-[62mm] break-after-page flex-col items-center justify-center border border-ink/40 print:border-0">
              <p className="max-w-[58mm] truncate text-[8pt] font-semibold">
                {c.name}
                {c.className && ` · ${c.className}`}
              </p>
              <Barcode value={c.code!} widthMm={56} heightMm={14} />
              <p className="font-mono text-[7pt]">{c.code}</p>
            </section>
          ))}
        </main>
      )}
    </div>
  );
}
