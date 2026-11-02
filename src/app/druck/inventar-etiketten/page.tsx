import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { LABEL_FORMATS, labelFormat, labelsPerPage, paginate, type LabelFormat } from "@/core/etiketten/codes";
import { labelUrl, qrSvg } from "@/core/etiketten/qr";
import { requireModulePage } from "@/core/modules/guard";
import { readModuleSetting } from "@/core/modules/settings";
import { getSchoolSettings } from "@/core/settings";
import { inventoryLabels, type InventoryLabel } from "@/modules/gebaeude/etiketten";
import { LABEL_FORMAT_DEFAULT } from "@/modules/gebaeude/settings";
import { InventarEtikett } from "@/ui/inventar-etikett";
import { Button } from "@schulos/ui/button";
import { PrintButton } from "@schulos/ui/print-button";

export const metadata: Metadata = { title: "Inventar-Etiketten drucken" };

type Search = { asset?: string | string[]; alle?: string; kategorie?: string; raum?: string; ohne?: string; format?: string; ab?: string };

/**
 * INV-02: Etiketten mit Inventarnummer, Bezeichnung, Schulname und QR (`/i/<code>`) – einzeln oder als Sammeldruck (`asset`
 * mehrfach, `alle=1` mit Filtern). Nur pflegbares Inventar; fehlende Codes entstehen hier, vorhandene bleiben. A4-Bögen (3×8,
 * 4×13, optional ab Position `ab` für angefangene Bögen) oder Endlosrolle 62 mm (ein Etikett je Abschnitt).
 */
export default async function InventarEtikettenDruckPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModulePage("gebaeude");
  const { perms } = await requireUser();
  const sp = await searchParams;
  const db = await getDb();
  const format = labelFormat(sp.format, labelFormat(await readModuleSetting(db, LABEL_FORMAT_DEFAULT)));
  const ids = sp.asset === undefined ? [] : Array.isArray(sp.asset) ? sp.asset : [sp.asset];
  const all = sp.alle === "1";
  if (!all && ids.length === 0)
    return (
      <main className="flex flex-col items-start gap-3 p-6">
        <p role="alert">Kein Inventar gewählt.</p>
        <Button asChild variant="secondary" size="sm">
          <Link href="/gebaeude/inventar/etiketten">Zurück zur Auswahl</Link>
        </Button>
      </main>
    );
  const labels = await inventoryLabels(db, perms, all ? "alle" : ids.slice(0, 1000), { categoryId: sp.kategorie, roomId: sp.raum, withoutLabel: sp.ohne === "1" });
  if (labels.length === 0) notFound();
  const school = await getSchoolSettings();
  const f = LABEL_FORMATS[format];
  const perPage = labelsPerPage(format);
  const start = Math.min(Math.max(Number(sp.ab) || 1, 1), perPage) - 1;
  const cells: (InventoryLabel | null)[] = [...Array.from({ length: f.kind === "bogen" ? start : 0 }, () => null), ...labels];
  const pages = paginate(cells, perPage);
  const query = (fmt: LabelFormat) => {
    const q = new URLSearchParams();
    for (const id of ids) q.append("asset", id);
    for (const k of ["alle", "kategorie", "raum", "ohne", "ab"] as const) if (sp[k]) q.set(k, sp[k]!);
    q.set("format", fmt);
    return `?${q}`;
  };
  const back = ids.length === 1 && !all ? `/gebaeude/inventar/${encodeURIComponent(ids[0]!)}#etikett` : "/gebaeude/inventar/etiketten";
  const pageSize = f.kind === "rolle" ? `${f.widthMm}mm ${f.heightMm}mm` : "A4 portrait";
  return (
    <div data-theme="light" className="min-h-dvh bg-surface p-6 text-ink print:p-0">
      <style>{`@media print { @page { size: ${pageSize}; margin: 0; } }`}</style>
      <nav aria-label="Druckoptionen" className="mb-6 flex flex-col gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={back}>Zurück</Link>
          </Button>
          {(Object.keys(LABEL_FORMATS) as LabelFormat[]).map((x) => (
            <Button key={x} asChild variant={x === format ? "secondary" : "ghost"} size="sm">
              <Link href={query(x)} aria-current={x === format ? "page" : undefined}>
                {LABEL_FORMATS[x].label}
              </Link>
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PrintButton />
          <span className="text-sm text-muted">
            {labels.length === 1 ? "1 Etikett" : `${labels.length} Etiketten`} · in tatsächlicher Größe drucken (100 %, ohne Kopf-/Fußzeilen)
            {f.kind === "rolle" ? " · Rolle 62 mm, der Drucker schneidet je Etikett" : start > 0 ? ` · beginnt bei Etikett ${start + 1}` : ""}
          </span>
        </div>
      </nav>
      <main aria-label="Inventar-Etiketten" className={`flex flex-col ${f.kind === "rolle" ? "gap-2 print:gap-0" : "gap-6 print:gap-0"}`}>
        <h1 className="sr-only">Inventar-Etiketten drucken</h1>
        {pages.map((p, i) =>
          f.kind === "rolle" ? (
            <section key={i} aria-label={`Etikett ${i + 1}`} className="shrink-0 break-after-page bg-white">
              {p.map((l) => l && <InventarEtikett key={l.assetId} format={format} c={{ inventoryNo: l.inventoryNo, name: l.name, school: school.name, place: l.place, qrSvg: qrSvg(labelUrl("inventar", l.code)), url: labelUrl("inventar", l.code) }} />)}
            </section>
          ) : (
            <section
              key={i}
              aria-label={`Bogen ${i + 1}`}
              className="grid shrink-0 break-after-page content-start bg-white"
              style={{
                width: "210mm",
                height: "297mm",
                paddingTop: `${f.topMm}mm`,
                paddingLeft: `${f.leftMm}mm`,
                gridTemplateColumns: `repeat(${f.cols}, ${f.widthMm}mm)`,
                gridAutoRows: `${f.heightMm}mm`,
                columnGap: `${f.gapXMm}mm`,
                rowGap: `${f.gapYMm}mm`,
              }}
            >
              {p.map((l, j) =>
                l ? (
                  <InventarEtikett key={l.assetId} format={format} c={{ inventoryNo: l.inventoryNo, name: l.name, school: school.name, place: l.place, qrSvg: qrSvg(labelUrl("inventar", l.code)), url: labelUrl("inventar", l.code) }} />
                ) : (
                  <div key={`leer-${j}`} aria-hidden style={{ width: `${f.widthMm}mm`, height: `${f.heightMm}mm` }} />
                ),
              )}
            </section>
          ),
        )}
      </main>
    </div>
  );
}
