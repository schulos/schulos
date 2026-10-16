// JSON-Body der Texte-API (P3-11) – die Prüfung selbst (CSRF, Größe, Objekt) liegt in core/json-body.ts (auch für Tafeln).
import { json, readJsonBody } from "@/core/json-body";
import { LIMITS, type ApplyError } from "./live";

export { json };

/** Base64 ist um ein Drittel größer als die Bytes, dazu der JSON-Rahmen */
export const MAX_BODY_BYTES = Math.ceil(LIMITS.updateBytes * 1.4) + 1024;

/** JSON-Body lesen; zu groß → 413, kein Objekt → 400, nicht JSON → 415, fremde Origin → 403 (P311-05). */
export const readBody = (req: Request): Promise<Record<string, unknown> | Response> => readJsonBody(req, MAX_BODY_BYTES);

export const APPLY_ERRORS: Record<ApplyError, { status: number; error: string }> = {
  missing: { status: 404, error: "Nicht gefunden" },
  invalid: { status: 400, error: "Ungültige Änderung" },
  "too-large": { status: 413, error: "Die Änderung ist zu groß (höchstens 256 KB auf einmal)" },
  "doc-full": { status: 413, error: "Der Text ist zu groß geworden – bitte kürzen oder einen zweiten Text anlegen" },
  rate: { status: 429, error: "Zu viele Änderungen in kurzer Zeit" },
};
