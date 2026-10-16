// Tagesleiste: Stunden eines Tages mit Zustand relativ zur aktuellen Uhrzeit (rein, testbar).
import type { LessonSlot } from "./service";

export type StripState = "done" | "now" | "later";

export interface StripItem extends LessonSlot {
  state: StripState;
  /** nur bei „now": verbleibende Minuten */
  minutesLeft?: number;
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/**
 * Zustand jeder Stunde am Tag `ymd` zur Uhrzeit `nowYmd`/`nowHm` (Berliner Ortszeit).
 * Andere Tage: vergangene alle „done", künftige alle „later".
 */
export function dayStrip(slots: readonly LessonSlot[], ymd: string, nowYmd: string, nowHm: string): StripItem[] {
  const now = toMin(nowHm);
  return slots
    .filter((s) => s.date === ymd)
    .map((s) => {
      if (ymd < nowYmd) return { ...s, state: "done" as const };
      if (ymd > nowYmd) return { ...s, state: "later" as const };
      const start = toMin(s.startsAt);
      const end = toMin(s.endsAt);
      if (now >= end) return { ...s, state: "done" as const };
      if (now >= start) return { ...s, state: "now" as const, minutesLeft: end - now };
      return { ...s, state: "later" as const };
    });
}

/** Erster Tag ab `fromYmd` (einschließlich), an dem es Stunden gibt – oder null. */
export function firstDayWithLessons(slots: readonly LessonSlot[], fromYmd: string): string | null {
  return slots.map((s) => s.date).filter((d) => d >= fromYmd).sort()[0] ?? null;
}
