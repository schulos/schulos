// JSON-Body der Tafel-API (P3-12) – ohne Sitzung/DB, damit es sich direkt testen lässt; die Prüfung selbst (CSRF, Größe,
// Objekt) liegt in core/json-body.ts.
import { json, readJsonBody } from "@/core/json-body";
import { LIMITS, type ApplyError } from "./live";

export { json };

/** Elemente als JSON plus Rahmen */
export const MAX_BODY_BYTES = LIMITS.updateBytes + 1024;

export const readBody = (req: Request) => readJsonBody(req, MAX_BODY_BYTES, "Die Änderung ist zu groß (höchstens 512 KB auf einmal)");

export const APPLY_ERRORS: Record<ApplyError, { status: number; error: string }> = {
  missing: { status: 404, error: "Nicht gefunden" },
  "too-large": { status: 413, error: "Die Tafel ist zu groß zum Öffnen (höchstens 4 MB)" },
  "invalid-file": { status: 422, error: "Die Datei ist keine gültige Tafel" },
  invalid: { status: 400, error: "Ungültige Änderung" },
  "too-many": { status: 413, error: "Zu viele Elemente auf einmal" },
  "board-full": { status: 413, error: "Die Tafel ist voll (4 MB) – bitte aufräumen oder eine zweite Tafel anlegen" },
  quota: { status: 413, error: "Der Speicherplatz des Gruppenordners ist voll – bitte dort aufräumen" },
  rate: { status: 429, error: "Zu viele Änderungen in kurzer Zeit" },
};
