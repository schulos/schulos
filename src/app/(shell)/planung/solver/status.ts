// SP-07: Anzeige des Lauf-Status – gemeinsam für Server-Seiten und die Live-Anzeige (Client).

export type RunStatusKey = "queued" | "running" | "done" | "failed" | "cancelled" | "applied";

export const RUN_STATUS: Record<RunStatusKey, { label: string; tone: "neutral" | "warn" | "success" | "danger" | "soft" }> = {
  queued: { label: "wartet", tone: "neutral" },
  running: { label: "rechnet", tone: "warn" },
  done: { label: "fertig", tone: "success" },
  failed: { label: "Fehler", tone: "danger" },
  cancelled: { label: "abgebrochen", tone: "neutral" },
  applied: { label: "übernommen", tone: "soft" },
};

/** Filter der Historie (Query `status`) */
export const STATUS_FILTERS: { key: string; label: string; statuses: RunStatusKey[] | null }[] = [
  { key: "", label: "Alle", statuses: null },
  { key: "aktiv", label: "Wartend/rechnend", statuses: ["queued", "running"] },
  { key: "fertig", label: "Fertig", statuses: ["done"] },
  { key: "uebernommen", label: "Übernommen", statuses: ["applied"] },
  { key: "ohne", label: "Abgebrochen/Fehler", statuses: ["cancelled", "failed"] },
];

export const isActive = (s: RunStatusKey) => s === "queued" || s === "running";

/** Felder der Gewichtung in Formular-Reihenfolge (alle Felder von `SolverWeights`, SP-G-16: auch `lateFrom`). */
export const WEIGHT_FIELDS = [
  { key: "pref", label: "Zeitwünsche", hint: "je Wunschpunkt" },
  { key: "teacherGap", label: "Hohlstunde Lehrkraft", hint: "je Hohlstunde" },
  { key: "classGap", label: "Hohlstunde Klasse", hint: "je Hohlstunde" },
  { key: "subjectTwice", label: "Fach mehrfach am Tag", hint: "je weiterem Block" },
  { key: "roomWish", label: "Raumwunsch verfehlt", hint: "je Stunde" },
  { key: "noRoom", label: "Ohne Raum", hint: "je Stunde" },
  { key: "late", label: "Späte Stunde", hint: "je Stunde nach der Grenze" },
  { key: "lateFrom", label: "Grenze späte Stunden", hint: "ganze Zahl: Stunden nach dieser zählen als spät" },
] as const;

export type WeightKey = (typeof WEIGHT_FIELDS)[number]["key"];
