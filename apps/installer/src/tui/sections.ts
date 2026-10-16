// Schrittleiste der Text-Oberfläche (INST-02): die Fragen als Abschnitte, dazu Zusammenfassung und Installation. Rein.
import { visibleSteps } from "../flow";
import type { Answers, InstallContext } from "../questions";

/** Abschnitt je Frage: nach dem Präfix der ID (`network.hostname` → Netzwerk) */
const BY_PREFIX: Record<string, string> = {
  locale: "Sprache & Region",
  role: "Rolle",
  instance: "Rolle",
  disk: "Platte",
  network: "Netzwerk",
  access: "Zugang",
  updates: "Updates",
  school: "Schule",
  admin: "Administrator",
  web: "Adresse & Web",
  mail: "E-Mail",
  backup: "Backup",
  retention: "Aufbewahrung",
  offsite: "Offsite-Kopie",
  restore: "Wiederherstellung",
};

export const SUMMARY = "Zusammenfassung";
export const INSTALL = "Installation";

export function sectionOf(questionId: string): string {
  const s = BY_PREFIX[questionId.split(".")[0]!];
  if (!s) throw new Error(`Frage ${questionId} ohne Abschnitt`);
  return s;
}

export type SectionState = "done" | "current" | "open";

/** Wo die Oberfläche steht: bei einer Frage, in der Zusammenfassung oder bei der Installation */
export type Position = { questionId: string } | "summary" | "install" | "finished";

/** Abschnitte in der Reihenfolge der Fragen, die bei diesen Antworten gelten – mit Zustand für die Schrittleiste */
export function sections(answers: Answers, ctx: InstallContext, at: Position): { title: string; state: SectionState }[] {
  const titles = [...new Set(visibleSteps(answers, ctx).map((s) => sectionOf(s.question.id))), SUMMARY, INSTALL];
  const current =
    at === "summary" ? SUMMARY : at === "install" ? INSTALL : at === "finished" ? null : sectionOf(at.questionId);
  const ci = current === null ? titles.length : titles.indexOf(current);
  return titles.map((title, i) => ({ title, state: i < ci ? "done" : i === ci ? "current" : "open" }));
}

/** Ausschnitt einer Liste mit höchstens `max` Zeilen, der `index` zeigt (für lange Auswahllisten und die Schrittleiste) */
export function windowAround(length: number, index: number, max: number): { start: number; end: number } {
  if (length <= max) return { start: 0, end: length };
  const start = Math.min(Math.max(0, index - Math.floor(max / 2)), length - max);
  return { start, end: start + max };
}
