import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { requireModulePage } from "@/core/modules/guard";
import { markLabelsPrintedAction } from "@/modules/buecherei/actions";
import { LABEL_TEMPLATES, clampStart, labelTemplate, labelsToPrint, layoutPages, perSheet, slotPosition, type LabelSource, type LabelTemplate, type PrintLabel } from "@/modules/buecherei/etiketten";
import { canStock } from "@/modules/buecherei/service";
import { canMaterials, lernmittelEnabled, materialLabels } from "@/modules/buecherei/lernmittel";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";
import { Barcode } from "@/ui/barcode";

export const metadata: Metadata = { title: "Bücherei-Etiketten drucken" };

type Search = { quelle?: string; titel?: string; exemplar?: string; lernmittel?: string; "lernmittel-exemplar"?: string; vorlage?: string; start?: string; test?: string };

const mm = (n: number) => `${n}mm`;

/** Inhalt eines Etiketts: Signatur, Titel (gekürzt), Strichcode, Exemplarnummer – Größen folgen dem Etikett. */
function LabelBody({ l, t }: { l: PrintLabel; t: LabelTemplate }) {
  const barH = Math.min(14, Math.max(7, t.heightMm * 0.38));
  const small = t.heightMm < 30;
  return (
    <div className="flex size-full flex-col items-center justify-center overflow-hidden px-[2mm] text-center leading-tight">
      <p className={`w-full truncate font-bold ${small ? "text-[7pt]" : "text-[8pt]"}`}>{l.signature ?? "Bücherei"}</p>
      <p className={`w-full truncate ${small ? "text-[6pt]" : "text-[7pt]"}`}>{l.title}</p>
      <Barcode value={l.barcode} widthMm={Math.min(t.widthMm - 6, 60)} heightMm={barH} label={`Strichcode ${l.barcode}`} />
      <p className={`font-mono ${small ? "text-[6pt]" : "text-[7pt]"}`}>{l.barcode}</p>
    </div>
  );
}

/**
 * Druckansicht für Exemplar-Etiketten (BU-05, Recht `buecherei.stock`): A4-Bögen mit absolut gesetzten Etiketten in mm
 * (`@page` A4 ohne Rand) bzw. ein Etikett je Seite für Etikettendrucker. Startposition für angebrochene Bögen, Testseite
 * zum Ausrichten. „Als gedruckt markieren“ nimmt genau die gezeigten Exemplare aus der Warteschlange.
 */
export default async function EtikettenDruckPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModulePage("buecherei");
  const { perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  // BU-10: Inventarnummern der Lernmittel mit demselben Baustein – Recht `materials`, nur mit eingeschalteter Schulbuchausleihe
  const material = sp.lernmittel ? { materialId: sp.lernmittel } : sp["lernmittel-exemplar"] ? { copyId: sp["lernmittel-exemplar"] } : null;
  if (material ? !canMaterials(perms) || !(await lernmittelEnabled(db)) : !canStock(perms)) notFound();
  const t = labelTemplate(sp.vorlage);
  const test = sp.test === "1";
  const start = clampStart(t, sp.start);
  const src: LabelSource | null = sp.exemplar ? { kind: "exemplar", copyId: sp.exemplar } : sp.titel ? { kind: "titel", titleId: sp.titel } : sp.quelle === "warteschlange" ? { kind: "warteschlange" } : null;
  if (!test && !src && !material) notFound();
  const labels = test ? [] : material ? await materialLabels(db, perms, material) : src ? await labelsToPrint(db, perms, src) : [];
  const open = labels.filter((l) => !l.printed);
  // Testseite: alle Plätze eines Bogens bzw. ein Etikett, nur Rahmen und Nummer
  const pages: (PrintLabel | number | null)[][] = test ? [Array.from({ length: perSheet(t) }, (_, i) => i)] : layoutPages(t, labels, start);
  const back = sp.titel
    ? `/buecherei/bestand/${encodeURIComponent(sp.titel)}`
    : sp.lernmittel
      ? `/buecherei/lernmittel/${encodeURIComponent(sp.lernmittel)}`
      : material
        ? "/buecherei/lernmittel"
        : "/buecherei/etiketten";
  const query = (o: Record<string, string>) => {
    const base: Record<string, string> = {};
    for (const k of ["quelle", "titel", "exemplar", "lernmittel", "lernmittel-exemplar", "test", "start"] as const) if (sp[k]) base[k] = sp[k]!;
    return `?${new URLSearchParams({ ...base, ...o })}`;
  };
  const pageCss =
    t.kind === "bogen" ? "@media print { @page { size: A4 portrait; margin: 0; } }" : `@media print { @page { size: ${mm(t.widthMm)} ${mm(t.heightMm)}; margin: 0; } }`;

  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{pageCss}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={back}>Zurück</Link>
          </Button>
          {LABEL_TEMPLATES.map((x) => (
            <Button key={x.id} asChild variant={x.id === t.id ? "secondary" : "ghost"} size="sm">
              <Link href={query({ vorlage: x.id })} aria-current={x.id === t.id ? "page" : undefined}>
                {x.label}
              </Link>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PrintButton />
          <span className="text-sm text-muted">
            {test
              ? `Testseite ${t.label} – auf normales Papier drucken und gegen den Bogen halten (Druck in tatsächlicher Größe, ohne Kopf-/Fußzeilen)`
              : `${labels.length} ${labels.length === 1 ? "Etikett" : "Etiketten"} · ${t.label}${t.kind === "bogen" && start > 1 ? ` · ab Position ${start}` : ""}`}
          </span>
        </div>
        {!test && open.length > 0 && (
          <form action={markLabelsPrintedAction} aria-label="Als gedruckt markieren" className="flex flex-wrap items-center gap-3">
            {open.map((l) => (
              <input key={l.copyId} type="hidden" name="copyId" value={l.copyId} />
            ))}
            <Button type="submit" variant="secondary" size="sm">
              {open.length === 1 ? "Als gedruckt markieren" : `${open.length} als gedruckt markieren`}
            </Button>
            <span className="text-xs text-muted">erst nach erfolgreichem Druck – nimmt die Exemplare aus der Warteschlange</span>
          </form>
        )}
        {!test && labels.length === 0 && <p className="text-sm text-muted">Keine Etiketten zu drucken.</p>}
      </nav>

      <main aria-label={test ? "Testseite" : "Etiketten"} className="flex flex-col gap-6 print:gap-0">
        {pages.map((cells, pi) =>
          t.kind === "bogen" ? (
            <section
              key={pi}
              aria-label={`Bogen ${pi + 1}`}
              className="relative shrink-0 break-after-page overflow-hidden border border-ink/30 bg-white print:border-0"
              style={{ width: "210mm", height: "297mm" }}
            >
              {cells.map((c, i) => {
                const p = slotPosition(t, i);
                return (
                  <div
                    key={i}
                    className={test ? "absolute flex items-center justify-center border border-dashed border-ink/60 text-[10pt]" : "absolute"}
                    style={{ left: mm(p.xMm), top: mm(p.yMm), width: mm(t.widthMm), height: mm(t.heightMm) }}
                  >
                    {test ? <span className="tabular-nums">{i + 1}</span> : c !== null && typeof c === "object" ? <LabelBody l={c} t={t} /> : null}
                  </div>
                );
              })}
            </section>
          ) : (
            <section
              key={pi}
              aria-label={`Etikett ${pi + 1}`}
              className="shrink-0 break-after-page overflow-hidden border border-ink/30 bg-white print:border-0"
              style={{ width: mm(t.widthMm), height: mm(t.heightMm) }}
            >
              {test ? (
                <div className="flex size-full items-center justify-center border border-dashed border-ink/60 text-[9pt]">
                  {t.widthMm} × {t.heightMm} mm
                </div>
              ) : (
                cells[0] !== null && typeof cells[0] === "object" && <LabelBody l={cells[0] as PrintLabel} t={t} />
              )}
            </section>
          ),
        )}
      </main>
    </div>
  );
}
