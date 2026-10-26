import { Download } from "lucide-react";
import { canExport, EXPORT_LABELS, type ExportArt } from "@/modules/stundenplan/exporte";
import type { PermissionSet } from "@/core/permissions";

/**
 * SP2-10: Knopf „Drucken/CSV“ der Planungsreiter. Zeigt je Export (nur die, die der Betrachter sehen darf) einen Druck- und
 * einen CSV-Link; ohne erlaubten Export erscheint nichts. `zeitraum` wird an die Statistik durchgereicht.
 */
export function ExportMenu({ arts, perms, zeitraum }: { arts: readonly ExportArt[]; perms: PermissionSet; zeitraum?: string }) {
  const allowed = arts.filter((a) => canExport(a, perms));
  if (allowed.length === 0) return null;
  const q = zeitraum === "monat" ? "&zeitraum=monat" : "";
  return (
    <details className="relative">
      <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg bg-surface-2 px-4 text-sm font-semibold ring-1 ring-border hover:ring-border-strong">
        <Download aria-hidden className="size-4" /> Drucken/CSV
      </summary>
      <ul className="absolute right-0 z-10 mt-1 flex min-w-64 flex-col gap-1 rounded-lg bg-surface p-2 shadow-lg ring-1 ring-border">
        {allowed.map((a) => (
          <li key={a} className="flex items-center justify-between gap-3 text-sm">
            <span>{EXPORT_LABELS[a]}</span>
            <span className="flex gap-2">
              <a className="text-accent-ink hover:underline" href={`/druck/stundenplan/uebersicht?art=${a}${q}`} aria-label={`${EXPORT_LABELS[a]} drucken`}>
                Drucken
              </a>
              <a className="text-accent-ink hover:underline" href={`/api/stundenplan/export/${a}${q ? `?${q.slice(1)}` : ""}`} download aria-label={`${EXPORT_LABELS[a]} als CSV`}>
                CSV
              </a>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
