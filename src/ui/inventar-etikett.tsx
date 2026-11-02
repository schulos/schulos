// INV-02: Inventar-Etikett mit QR-Code für den Druck (gemeinsamer Unterbau mit dem Türschild `qr-schild.tsx`). Feste Maße in mm
// (`LABEL_FORMATS`: A4-Bögen 3×8 und 4×13, Endlosrolle 62 mm), immer hell. Inhalt: QR, Inventarnummer, Kurzname, Schulname.
// Das SVG stammt aus `qrSvg()` (eigene URL, kein Fremdinhalt).
import { LABEL_FORMATS, type LabelFormat } from "@/core/etiketten/codes";

export interface InventarEtikettContent {
  inventoryNo: string;
  name: string;
  /** Schulname (entfällt auf dem kleinsten Raster) */
  school?: string;
  /** Standort, z. B. „Raum 112 · Hauptgebäude“ */
  place?: string;
  qrSvg: string;
  url: string;
}

export function InventarEtikett({ c, format }: { c: InventarEtikettContent; format: LabelFormat }) {
  const f = LABEL_FORMATS[format];
  const small = format === "bogen-4x13";
  const qrMm = small ? 16 : format === "rolle-62" ? 23 : 28;
  return (
    <article
      aria-label={`Etikett ${c.inventoryNo}`}
      className={`flex shrink-0 items-center overflow-hidden bg-white text-ink ${small ? "gap-[1.5mm] px-[1.5mm] py-[1mm]" : "gap-[3mm] px-[3mm] py-[2mm]"} print:border-0 ${f.kind === "bogen" ? "border border-dashed border-ink/20" : "border border-ink/30"}`}
      style={{ width: `${f.widthMm}mm`, height: `${f.heightMm}mm` }}
    >
      <figure className="flex shrink-0 flex-col items-center">
        <div
          role="img"
          aria-label={`QR-Code ${c.url}`}
          className="[&>svg]:size-full"
          style={{ width: `${qrMm}mm`, height: `${qrMm}mm` }}
          // SVG aus uqr mit der eigenen Kurz-URL – kein Fremdinhalt
          dangerouslySetInnerHTML={{ __html: c.qrSvg }}
        />
      </figure>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        {c.school && !small && <p className="truncate text-[6pt] text-muted">{c.school}</p>}
        <p className={`font-mono font-bold break-all ${small ? "text-[8pt]" : "text-[11pt]"}`}>{c.inventoryNo}</p>
        <p className={`${small ? "line-clamp-1 text-[6pt]" : "line-clamp-2 text-[7.5pt]"} break-words`}>{c.name}</p>
        {c.place && !small && <p className="truncate text-[6pt] text-muted">{c.place}</p>}
      </div>
    </article>
  );
}
