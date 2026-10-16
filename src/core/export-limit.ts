// Grenzen für teure Exporte (SEC-05): ZIP-Exporte lesen Dateien in den Speicher und komprimieren sie. Ohne Grenze
// legen parallele Aufrufe (oder ein Forenbild mit `![](/api/eigenexport)`) den einzigen Node-Prozess lahm.
// - nur per POST (Formular-Knopf); GET liefert 405 – Bilder, Links und Vorabrufe lösen nichts aus
// - je Konto höchstens ein laufender Export, kurze Pause zwischen zwei Exporten, global wenige gleichzeitig
// - Obergrenze der Datenmenge (MAX_EXPORT_BYTES), geprüft vor dem Lesen der Dateien
// Der Zustand liegt am globalThis: Route-Bundles teilen sich sonst keine Modulvariablen.

export const EXPORT_LIMITS = {
  /** gleichzeitig laufende Exporte im ganzen Server */
  global: 2,
  /** Mindestabstand zwischen zwei Eigenexporten desselben Kontos (Verwaltungsexporte: nur einer zur Zeit je Konto) */
  ownExportIntervalMs: 10_000,
};

/** Höchstens so viele Bytes Dateien in einem ZIP – darüber Dateien einzeln herunterladen bzw. Verwaltung fragen. */
export const MAX_EXPORT_BYTES = 500 * 1024 * 1024;

export class ExportTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Export zu groß: ${Math.ceil(bytes / 1024 / 1024)} MB (höchstens ${MAX_EXPORT_BYTES / 1024 / 1024} MB)`);
  }
}

/** Wirft ExportTooLargeError, wenn die Summe der Dateigrößen die Obergrenze übersteigt. */
export function assertExportSize(bytes: number): void {
  if (bytes > MAX_EXPORT_BYTES) throw new ExportTooLargeError(bytes);
}

interface State {
  running: Set<string>;
  lastStart: Map<string, number>;
}
const g = globalThis as unknown as { __schulosExports?: State };
const state = (): State => (g.__schulosExports ??= { running: new Set(), lastStart: new Map() });

export type ExportSlot = { ok: true; release: () => void } | { ok: false; reason: string; retryAfter: number };

/** Platz für einen Export des Kontos `key` belegen; `release()` immer im finally aufrufen. */
export function acquireExportSlot(key: string, opts: { minIntervalMs?: number; now?: number } = {}): ExportSlot {
  const now = opts.now ?? Date.now();
  const interval = opts.minIntervalMs ?? 0;
  const s = state();
  if (s.running.has(key)) return { ok: false, reason: "Dein Export läuft noch – bitte warten.", retryAfter: 10 };
  const last = s.lastStart.get(key);
  if (last !== undefined && now - last < interval)
    return { ok: false, reason: "Bitte kurz warten und dann erneut versuchen.", retryAfter: Math.ceil((interval - (now - last)) / 1000) };
  if (s.running.size >= EXPORT_LIMITS.global)
    return { ok: false, reason: "Gerade laufen andere Exporte – bitte gleich noch einmal versuchen.", retryAfter: 15 };
  s.running.add(key);
  s.lastStart.set(key, now);
  // alte Zeitstempel nicht ewig halten
  if (s.lastStart.size > 1000) for (const [k, t] of s.lastStart) if (now - t > EXPORT_LIMITS.ownExportIntervalMs) s.lastStart.delete(k);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      s.running.delete(key);
    },
  };
}

/** Nur für Tests: Zustand zurücksetzen. */
export function resetExportSlots(): void {
  g.__schulosExports = undefined;
}

/**
 * Vorprüfung einer Export-Anfrage: nur POST, nicht aus Bildern/Einbettungen und nicht von fremden Seiten
 * (Sitzungs-Cookie ist SameSite=Lax; Sec-Fetch-* zusätzlich, falls der Browser sie mitsendet). null = in Ordnung.
 */
export function exportRequestError(req: Request): Response | null {
  if (req.method !== "POST") return new Response("Export nur über den Knopf (POST)", { status: 405, headers: { Allow: "POST" } });
  const dest = req.headers.get("sec-fetch-dest");
  const site = req.headers.get("sec-fetch-site");
  if ((dest && !["document", "empty"].includes(dest)) || site === "cross-site") return new Response("Kein Zugriff", { status: 403 });
  return null;
}

/** Antwort, wenn kein Platz frei ist bzw. der Export zu groß ist. */
export function exportBusyResponse(slot: Extract<ExportSlot, { ok: false }>): Response {
  return new Response(slot.reason, { status: 429, headers: { "Retry-After": String(slot.retryAfter), "Content-Type": "text/plain; charset=utf-8" } });
}

export function zipResponse(zip: Uint8Array, filename: string): Response {
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
