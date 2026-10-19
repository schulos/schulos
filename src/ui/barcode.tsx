import { code128Widths } from "@/modules/buecherei/code128";

/**
 * Code 128 als SVG (BU-07, später Etiketten BU-05): Striche als Rechtecke in Modul-Einheiten, Ruhezone 10 Module je Seite.
 * Breite/Höhe in mm, damit der Druck maßhaltig ist; Farbe fest Schwarz auf Weiß (Scanner brauchen Kontrast, auch im Dunkelmodus).
 */
export function Barcode({ value, widthMm, heightMm, label }: { value: string; widthMm: number; heightMm: number; label?: string }) {
  const widths = code128Widths(value);
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + 2 * quiet;
  const bars: { x: number; w: number }[] = [];
  let x = quiet;
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return (
    <svg
      role="img"
      aria-label={label ?? `Strichcode ${value}`}
      viewBox={`0 0 ${total} 50`}
      preserveAspectRatio="none"
      // Strichcodes brauchen Schwarz auf Weiß (Scanner), unabhängig vom Farbschema – bewusst keine Tokens
      style={{ width: `${widthMm}mm`, height: `${heightMm}mm`, background: "white" }}
      shapeRendering="crispEdges"
    >
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={0} width={b.w} height={50} fill="black" />
      ))}
    </svg>
  );
}
