import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { checkSvg } from "@/core/images-svg";
import { bytes, JPEG_64x48, pngOf, WEBP_VP8L } from "@/core/images.fixtures";
import { referencedStorageKeys, sweepOrphanFiles } from "@/core/privacy/dateispeicher";
import { LINDENHOF_LOGO_DARK_SVG, LINDENHOF_LOGO_SVG, LINDENHOF_SYMBOL_SVG } from "@/core/seed/lindenhof-logo";
import { logoUrl } from "@/core/school/logo-meta";
import { readSchoolSettings } from "@/core/settings";
import { ValidationError } from "@/modules/verwaltung/users";
import { parseLogoVariant, prepareLogo, readLogos, removeSchoolLogo, setSchoolLogo } from "./logo";

const enc = (s: string) => new TextEncoder().encode(s);
const SVG = enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><rect width="200" height="50" fill="#0e7c66"/></svg>');
const fieldError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.fieldErrors;
    throw e;
  }
  return null;
};

describe("Schullogo: Datei prüfen (rein)", () => {
  it("nimmt PNG, JPEG, WebP und SVG an und liest die Maße", () => {
    expect(prepareLogo(pngOf(400, 100), "logo")).toMatchObject({ mime: "image/png", size: { width: 400, height: 100 } });
    expect(prepareLogo(JPEG_64x48, "logo")).toMatchObject({ mime: "image/jpeg", size: { width: 64, height: 48 } });
    expect(prepareLogo(WEBP_VP8L, "dark")).toMatchObject({ mime: "image/webp", size: { width: 20, height: 10 } });
    expect(prepareLogo(SVG, "logo")).toMatchObject({ mime: "image/svg+xml", size: { width: 200, height: 50 } });
  });

  it("lehnt SVG mit Skript mit verständlicher Meldung ab", () => {
    const evil = enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>');
    expect(fieldError(() => prepareLogo(evil, "logo"))?.logo).toMatch(/aus Sicherheitsgründen nicht angenommen: Sie enthält ein Skript/);
  });

  it("Grenzen: Größe je Variante, Typ, Symbol fast quadratisch", () => {
    expect(fieldError(() => prepareLogo(new Uint8Array(), "logo"))).toEqual({ logo: "Bitte eine Bilddatei auswählen." });
    const big = new Uint8Array(600 * 1024).fill(0x20);
    expect(fieldError(() => prepareLogo(big, "symbol"))).toEqual({ symbol: "Die Datei ist zu groß (höchstens 512 KB)." });
    expect(fieldError(() => prepareLogo(new Uint8Array(1024 * 1024 + 1), "logo"))).toEqual({ logo: "Die Datei ist zu groß (höchstens 1 MB)." });
    expect(fieldError(() => prepareLogo(bytes("GIF89a.........."), "logo"))?.logo).toMatch(/PNG, JPEG, WebP oder SVG/);
    expect(fieldError(() => prepareLogo(pngOf(400, 100), "symbol"))?.symbol).toMatch(/quadratisch/);
    expect(prepareLogo(pngOf(64, 60), "symbol").size).toEqual({ width: 64, height: 60 });
  });

  it("Demo-Logos (Lindenhof) bestehen den eigenen Filter, das Symbol ist quadratisch", () => {
    for (const s of [LINDENHOF_LOGO_SVG, LINDENHOF_LOGO_DARK_SVG, LINDENHOF_SYMBOL_SVG]) expect(checkSvg(enc(s)).ok).toBe(true);
    expect(LINDENHOF_LOGO_DARK_SVG).not.toBe(LINDENHOF_LOGO_SVG);
    expect(prepareLogo(enc(LINDENHOF_SYMBOL_SVG), "symbol").size).toEqual({ width: 96, height: 96 });
  });

  it("Variante aus der Adresse", () => {
    expect(parseLogoVariant(null)).toBe("logo");
    expect(parseLogoVariant("dark")).toBe("dark");
    expect(parseLogoVariant("symbol")).toBe("symbol");
    expect(parseLogoVariant("../x")).toBeNull();
    expect(logoUrl("logo", { hash: "abc12345" })).toBe("/api/schule/logo?v=abc12345");
    expect(logoUrl("symbol", { hash: "abc12345" })).toBe("/api/schule/logo?variante=symbol&v=abc12345");
  });
});

describe("Schullogo: speichern, ersetzen, entfernen", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const keys = async () => new Set((await storage.list()).map((f) => f.key));
  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-logo-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("setzt das Logo, Schuldaten liefern es mit; Ersetzen löscht die alte Datei; Audit", async () => {
    const first = await setSchoolLogo(h.db, storage, null, "logo", pngOf(300, 100));
    expect((await readSchoolSettings(h.db)).logos.logo).toEqual(first);
    expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await keys()).has(first.key)).toBe(true);

    const second = await setSchoolLogo(h.db, storage, null, "logo", SVG);
    expect(second.mime).toBe("image/svg+xml");
    expect(second.hash).not.toBe(first.hash);
    const now = await keys();
    expect(now.has(first.key)).toBe(false);
    expect(now.has(second.key)).toBe(true);

    await setSchoolLogo(h.db, storage, "u-admin", "symbol", pngOf(64, 64));
    const logged = await h.db
      .select({ target: auditLog.target, meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.action, "verwaltung.school.logo"), eq(auditLog.actorId, "u-admin")));
    expect(logged).toEqual([{ target: "symbol", meta: expect.objectContaining({ action: "set", mime: "image/png" }) }]);
  });

  it("der nächtliche Aufräumlauf lässt Logo-Dateien stehen", async () => {
    const logos = await readLogos(h.db);
    const orphan = crypto.randomUUID();
    await storage.put(orphan, new Uint8Array([1]));
    const known = await referencedStorageKeys(h.db);
    expect(known.has(logos.logo!.key)).toBe(true);
    expect(known.has(logos.symbol!.key)).toBe(true);
    expect(await sweepOrphanFiles(h.db, storage, new Date(Date.now() + 2 * 3600_000))).toBe(1);
    const left = await keys();
    expect(left.has(logos.logo!.key)).toBe(true);
    expect(left.has(logos.symbol!.key)).toBe(true);
    expect(left.has(orphan)).toBe(false);
  });

  it("Entfernen löscht Einstellung und Datei", async () => {
    const before = (await readLogos(h.db)).logo!;
    expect(await removeSchoolLogo(h.db, storage, "u-admin", "logo")).toBe(true);
    expect((await readSchoolSettings(h.db)).logos.logo).toBeUndefined();
    expect((await keys()).has(before.key)).toBe(false);
    expect(await removeSchoolLogo(h.db, storage, "u-admin", "logo")).toBe(false);
    expect((await readSchoolSettings(h.db)).logos.symbol).toBeDefined();
  });
});
