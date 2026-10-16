import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExportSlot,
  assertExportSize,
  EXPORT_LIMITS,
  exportRequestError,
  ExportTooLargeError,
  MAX_EXPORT_BYTES,
  resetExportSlots,
} from "./export-limit";

describe("Export-Grenzen (SEC-05)", () => {
  afterEach(() => resetExportSlots());

  it("je Konto höchstens ein laufender Export, global begrenzt; Freigabe gibt den Platz zurück", () => {
    const a = acquireExportSlot("eigenexport:a");
    expect(a.ok).toBe(true);
    expect(acquireExportSlot("eigenexport:a").ok).toBe(false);
    const slots = [a];
    for (let i = 1; i < EXPORT_LIMITS.global; i++) slots.push(acquireExportSlot(`eigenexport:x${i}`));
    expect(slots.every((s) => s.ok)).toBe(true);
    const busy = acquireExportSlot("eigenexport:b");
    expect(busy).toMatchObject({ ok: false, retryAfter: expect.any(Number) });
    for (const s of slots) if (s.ok) s.release();
    expect(acquireExportSlot("eigenexport:b").ok).toBe(true);
  });

  it("Mindestabstand nur, wo verlangt (Eigenexport)", () => {
    const first = acquireExportSlot("eigenexport:c", { minIntervalMs: 10_000, now: 1_000 });
    if (first.ok) first.release();
    expect(acquireExportSlot("eigenexport:c", { minIntervalMs: 10_000, now: 5_000 }).ok).toBe(false);
    const later = acquireExportSlot("eigenexport:c", { minIntervalMs: 10_000, now: 12_000 });
    expect(later.ok).toBe(true);
    if (later.ok) later.release();
    // Verwaltungsexporte ohne Abstand: mehrere Klassen nacheinander
    const one = acquireExportSlot("archiv:d", { now: 1_000 });
    if (one.ok) one.release();
    expect(acquireExportSlot("archiv:d", { now: 1_001 }).ok).toBe(true);
  });

  it("nur POST; Bilder, Einbettungen und fremde Seiten werden abgewiesen", () => {
    const req = (method: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/eigenexport", { method, headers });
    expect(exportRequestError(req("GET"))?.status).toBe(405);
    expect(exportRequestError(req("POST", { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    expect(exportRequestError(req("POST", { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(exportRequestError(req("POST", { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(exportRequestError(req("POST"))).toBeNull();
  });

  it("Obergrenze der Datenmenge", () => {
    expect(() => assertExportSize(MAX_EXPORT_BYTES)).not.toThrow();
    expect(() => assertExportSize(MAX_EXPORT_BYTES + 1)).toThrow(ExportTooLargeError);
  });
});
