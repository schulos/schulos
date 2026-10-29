// RS-11: Schild/Etikett mit QR-Code für den Druck (gemeinsamer Unterbau – Türschild jetzt, Inventar-Etikett später).
// Feste Maße in mm (A5 quer bzw. A4 hoch, `SIGN_FORMATS`), immer hell (Druck). Das SVG stammt aus `qrSvg()` (eigene URL).
import { SIGN_FORMATS, type SignFormat } from "@/core/etiketten/codes";

export interface QrSchildContent {
  /** kleine Zeile oben, z. B. Schulname */
  eyebrow?: string;
  /** groß, z. B. Raumkürzel */
  title: string;
  subtitle?: string;
  /** weitere Zeilen, z. B. „Hauptgebäude · 1. OG“ */
  lines: string[];
  qrSvg: string;
  /** Kurz-URL in Klartext unter dem QR (zum Abtippen) */
  url: string;
  hint?: string;
}

export function QrSchild({ c, format }: { c: QrSchildContent; format: SignFormat }) {
  const f = SIGN_FORMATS[format];
  const wide = format === "a5";
  return (
    <article
      aria-label={`Schild ${c.title}`}
      className={`flex shrink-0 overflow-hidden border border-ink/30 bg-white text-ink print:border-0 ${wide ? "flex-row items-center gap-[10mm] p-[12mm]" : "flex-col items-center gap-[12mm] p-[18mm] text-center"}`}
      style={{ width: `${f.widthMm}mm`, height: `${f.heightMm}mm` }}
    >
      <div className={`flex min-w-0 flex-col ${wide ? "flex-1" : "items-center"}`}>
        {c.eyebrow && <p className="text-[11pt] text-muted">{c.eyebrow}</p>}
        <p className={`font-display leading-none font-bold break-words ${wide ? "text-[44pt]" : "text-[64pt]"}`}>{c.title}</p>
        {c.subtitle && <p className={`mt-[3mm] font-semibold break-words ${wide ? "text-[20pt]" : "text-[26pt]"}`}>{c.subtitle}</p>}
        {c.lines.map((l) => (
          <p key={l} className={`mt-[2mm] ${wide ? "text-[14pt]" : "text-[18pt]"}`}>
            {l}
          </p>
        ))}
        {c.hint && <p className={`mt-[6mm] text-muted ${wide ? "text-[9pt]" : "text-[11pt]"}`}>{c.hint}</p>}
      </div>
      <figure className="flex shrink-0 flex-col items-center gap-[2mm]">
        <div
          role="img"
          aria-label={`QR-Code ${c.url}`}
          className={`[&>svg]:size-full ${wide ? "size-[62mm]" : "size-[100mm]"}`}
          // SVG aus uqr mit der eigenen Kurz-URL – kein Fremdinhalt
          dangerouslySetInnerHTML={{ __html: c.qrSvg }}
        />
        <figcaption className="font-mono text-[9pt] break-all">{c.url}</figcaption>
      </figure>
    </article>
  );
}
