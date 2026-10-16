// Zeitraster und Vorschlag „Termine hintereinander“ (P4-50) – rein, ohne Datenbank, getestet.
import type { SprechtagBreak } from "./schema";

export const SLOT_MINUTES = [5, 10, 15, 20, 30] as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTime(s: string): boolean {
  return TIME.test(s);
}

/** „16:30“ → 990 */
export function toMinutes(hm: string): number {
  const m = TIME.exec(hm);
  if (!m) throw new Error(`Ungültige Uhrzeit: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 990 → „16:30“ */
export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export interface Raster {
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  breaks: readonly SprechtagBreak[];
}

/**
 * Alle Gesprächsbeginne eines Sprechtags: ab Beginn im Takt der Gesprächslänge, solange das Gespräch vor dem Ende fertig
 * ist; Gespräche, die in eine Pause ragen, fallen weg – nach der Pause geht es mit deren Ende weiter.
 */
export function slotsFor(r: Raster): string[] {
  const end = toMinutes(r.endsAt);
  const breaks = r.breaks.map((b) => ({ from: toMinutes(b.from), to: toMinutes(b.to) })).sort((a, b) => a.from - b.from);
  const out: string[] = [];
  let t = toMinutes(r.startsAt);
  while (t + r.slotMinutes <= end) {
    const hit = breaks.find((b) => t < b.to && t + r.slotMinutes > b.from);
    if (hit) {
      t = Math.max(hit.to, t + 1);
      continue;
    }
    out.push(fromMinutes(t));
    t += r.slotMinutes;
  }
  return out;
}

/** Ende eines Gesprächs („16:30“ + 10 → „16:40“) */
export function slotEnd(slot: string, minutes: number): string {
  return fromMinutes(toMinutes(slot) + minutes);
}

/** Prüft ein Raster; Fehlertexte je Feld (leer = in Ordnung). */
export function checkRaster(r: Raster): Record<string, string> {
  const fe: Record<string, string> = {};
  if (!isTime(r.startsAt)) fe.startsAt = "Beginn als Uhrzeit angeben (z. B. 16:00)";
  if (!isTime(r.endsAt)) fe.endsAt = "Ende als Uhrzeit angeben (z. B. 19:00)";
  else if (isTime(r.startsAt) && toMinutes(r.endsAt) <= toMinutes(r.startsAt)) fe.endsAt = "Das Ende liegt vor dem Beginn";
  if (!(SLOT_MINUTES as readonly number[]).includes(r.slotMinutes)) fe.slotMinutes = "Gesprächslänge wählen";
  for (const b of r.breaks) {
    if (!isTime(b.from) || !isTime(b.to) || toMinutes(b.to) <= toMinutes(b.from)) {
      fe.breaks = "Pause als „von–bis“ angeben (z. B. 17:30–17:45)";
      break;
    }
  }
  if (Object.keys(fe).length === 0 && slotsFor(r).length === 0) fe.endsAt = "Im Zeitraum passt kein Gespräch";
  return fe;
}

/** „17:30-17:45, 18:30-18:40“ → Pausen; ungültige Teile bleiben als Text stehen (checkRaster meldet sie). */
export function parseBreaks(text: string): SprechtagBreak[] {
  return text
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [from = "", to = ""] = s.split(/\s*[-–]\s*/);
      return { from: from.padStart(5, "0"), to: to.padStart(5, "0") };
    });
}

export function breaksText(breaks: readonly SprechtagBreak[]): string {
  return breaks.map((b) => `${b.from}–${b.to}`).join(", ");
}

export interface SequenceRequest {
  /** z. B. „<lehrkraft>:<kind>“ */
  key: string;
  /** freie Zeiten bei dieser Lehrkraft */
  free: ReadonlySet<string>;
}

/**
 * Vorschlag „Termine hintereinander“ (einfacher Greedy): Für jeden möglichen Beginn werden die Wünsche Zeit für Zeit
 * verteilt – an jeder Zeit der Wunsch, der danach am wenigsten freie Zeiten hat. Gewählt wird der Vorschlag mit der
 * kürzesten Gesamtdauer (bei Gleichstand der frühere). Zeiten in `busy` (schon gebucht) bleiben frei.
 * Lässt sich nicht jeder Wunsch unterbringen, kommt null zurück.
 */
export function suggestSequence(slots: readonly string[], requests: readonly SequenceRequest[], busy: ReadonlySet<string> = new Set()): { key: string; slot: string }[] | null {
  if (requests.length === 0) return [];
  let best: { span: number; start: number; plan: { key: string; slot: string }[] } | null = null;
  for (let s = 0; s < slots.length; s++) {
    const remaining = [...requests];
    const plan: { key: string; slot: string }[] = [];
    let first = -1;
    let last = -1;
    for (let i = s; i < slots.length && remaining.length > 0; i++) {
      const slot = slots[i]!;
      if (busy.has(slot)) continue;
      const candidates = remaining.filter((r) => r.free.has(slot));
      if (candidates.length === 0) continue;
      const laterFree = (r: SequenceRequest) => slots.slice(i + 1).filter((x) => r.free.has(x) && !busy.has(x)).length;
      candidates.sort((a, b) => laterFree(a) - laterFree(b) || a.key.localeCompare(b.key));
      const pick = candidates[0]!;
      remaining.splice(remaining.indexOf(pick), 1);
      plan.push({ key: pick.key, slot });
      if (first < 0) first = i;
      last = i;
    }
    if (remaining.length > 0 || first < 0) continue;
    const span = last - first;
    if (!best || span < best.span) best = { span, start: first, plan };
  }
  return best?.plan ?? null;
}

/** „106“ → „Raum 106“; Namen, die schon mit „Raum“ beginnen, bleiben („Raum 106“). */
export function roomLabel(name: string): string {
  return /^raum\b/i.test(name.trim()) ? name.trim() : `Raum ${name.trim()}`;
}
