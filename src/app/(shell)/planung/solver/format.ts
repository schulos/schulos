// SP-07: Formatierung für die Solver-Seiten (Liste, Detail).
import { TZ } from "@/core/time";

export const timeFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: TZ });
export const num = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

export const runTitle = (r: { label: string | null; createdAt: Date }) => r.label ?? `Lauf vom ${timeFmt.format(r.createdAt)}`;

export function duration(ms: number): string {
  if (ms < 60_000) return `${num.format(Math.round(ms / 100) / 10)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}
