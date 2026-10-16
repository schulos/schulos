// GATE-4c (Security „prüfen“ 1): Server Actions von außen nur, wenn sie öffentlich sind.
//
// Next leitet eine POST mit `Next-Action` auf eine erlaubte Seite (z. B. `/anmeldung`) an den Worker der Seite weiter, zu der
// die Action gehört (`createForwardedActionResponse`) – auch an `/login` oder die Verwaltung. Heute läuft das ins Leere, weil
// die Weiterleitung das Kennzeichen von Caddy mitschickt und `src/proxy.ts` das Ziel dann sperrt. Damit die Sicherheit nicht
// an diesem Nebeneffekt hängt, lässt der Proxy in der Zone „oeffentlich“ nur Action-IDs aus den öffentlichen Action-Dateien
// durch. Die IDs stehen im Manifest des Builds (`.next/server/server-reference-manifest.json`, auch im Standalone-Image).
// Fehlt bzw. ist das Manifest kaputt, gilt keine ID als öffentlich (geschlossen statt offen).
import { readFileSync } from "node:fs";
import path from "node:path";

/** Dateien mit Server Actions, die ohne Sitzung von außen erreichbar sein dürfen (Pfad ab `src/`) */
export const PUBLIC_ACTION_FILES = ["modules/anmeldung/public-actions.ts"] as const;

type ManifestEntry = { filename?: unknown };

/** Rein: öffentliche Action-IDs aus dem Server-Reference-Manifest (Laufzeiten `node` und `edge`). */
export function parsePublicActionIds(manifest: unknown, files: readonly string[] = PUBLIC_ACTION_FILES): Set<string> {
  const out = new Set<string>();
  const m = manifest as { node?: Record<string, ManifestEntry>; edge?: Record<string, ManifestEntry> } | null;
  // Pfade im Manifest: lokal absolut („../D:\…\src\modules\…“), im Linux-Build relativ zu src/ („modules/…“)
  const suffixes = files.map((f) => `/src/${f}`);
  for (const section of [m?.node, m?.edge]) {
    if (!section || typeof section !== "object") continue;
    for (const [id, entry] of Object.entries(section)) {
      const name = typeof entry?.filename === "string" ? entry.filename.replace(/\\/g, "/") : "";
      if (/^[0-9a-f]{20,}$/i.test(id) && (files.includes(name) || suffixes.some((s) => name.endsWith(s)))) out.add(id);
    }
  }
  return out;
}

let cached: Set<string> | undefined;

/** Öffentliche Action-IDs des laufenden Builds (einmal gelesen; ohne Manifest leer). */
export function publicActionIds(file = path.join(process.cwd(), ".next", "server", "server-reference-manifest.json")): ReadonlySet<string> {
  if (cached) return cached;
  try {
    cached = parsePublicActionIds(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    cached = new Set();
  }
  return cached;
}

/** Darf eine Anfrage von außen (Zone „oeffentlich“) diese Action aufrufen? Ohne `Next-Action` → ja (keine Action). */
export function externalActionAllowed(actionId: string | null, ids?: ReadonlySet<string>): boolean {
  return actionId === null || (ids ?? publicActionIds()).has(actionId);
}
