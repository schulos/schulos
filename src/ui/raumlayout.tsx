// RS-08: Raumlayout als Raster (nur lesen) – für Steckbrief, Layout-Seite und Druck. Ohne Hooks, auch serverseitig nutzbar.
// Jede Zelle trägt ihre Beschreibung für Screenreader („Reihe 1, Spalte 2: Platz“); sichtbar steht ein Kurzzeichen.
import { ELEMENT_LABELS, ELEMENT_SHORT, type LayoutCells, type LayoutElement } from "@/core/raumlayout-raster";
import { cellKey } from "@/core/raster";
import { cn } from "@schulos/ui/cn";

/** Farben je Element – nur Tokens. */
export function elementClass(el: LayoutElement | undefined): string {
  switch (el) {
    case "platz":
      return "border border-border-strong bg-surface font-medium";
    case "tisch":
      return "border border-border bg-surface-2";
    case "pult":
    case "tafel":
      return "border border-accent bg-accent-soft font-medium text-accent-ink";
    case undefined:
      return "border border-dashed border-border bg-transparent text-muted";
    default:
      return "border border-border bg-surface-2 text-muted italic";
  }
}

export function LayoutGrid({ rows, cols, cells, caption, print = false }: { rows: number; cols: number; cells: LayoutCells; caption: string; print?: boolean }) {
  return (
    <div className={cn(!print && "overflow-x-auto")}>
      <table className={cn("border-separate border-spacing-1", print ? "w-full table-fixed" : "min-w-max")}>
        <caption className="sr-only">{caption}. Reihe 1 ist vorn.</caption>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }, (_, c) => {
                const el = cells[cellKey(r, c)];
                return (
                  <td
                    key={c}
                    title={el ? ELEMENT_LABELS[el] : undefined}
                    className={cn("rounded-md px-1 text-center align-middle text-[11px] leading-tight", print ? "h-12" : "h-11 w-14 min-w-14", print && el ? "border border-ink/60" : elementClass(el))}
                  >
                    <span className="sr-only">
                      Reihe {r + 1}, Spalte {c + 1}: {el ? ELEMENT_LABELS[el] : "frei"}
                    </span>
                    <span aria-hidden>{el ? ELEMENT_SHORT[el] : ""}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
