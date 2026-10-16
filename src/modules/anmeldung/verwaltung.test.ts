import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { eq } from "drizzle-orm";
import { appSettings, auditLog } from "@/core/db/schema";
import {
  EMPTY_IMPRESSUM,
  IMPRESSUM_FIELDS_KEY,
  IMPRESSUM_LEGACY_KEY,
  assertImpressumComplete,
  missingImpressumFields,
  readImpressum,
  saveImpressum,
} from "@/core/school/impressum";
import { toggleModule } from "@/modules/verwaltung/rights";
import { ValidationError } from "@/modules/verwaltung/users";
import manifest from "./manifest";

describe("Schulanmeldung – Verwaltung (P4-33)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Modul: per Vorgabe aus, Einschalten nur mit Mailversand; Ausschalten geht immer", async () => {
    expect(manifest.defaultEnabled).toBe(false);
    await toggleModule(h.db, "u-admin", manifest, false, { mail: false });
    await expect(toggleModule(h.db, "u-admin", manifest, true, { mail: false })).rejects.toBeInstanceOf(ValidationError);
    await expect(toggleModule(h.db, "u-admin", manifest, true, { mail: false })).rejects.toMatchObject({ fieldErrors: { module: /SMTP/ } });
    expect(isEnabled(manifest, await loadModuleStates(h.db))).toBe(false);
    await toggleModule(h.db, "u-admin", manifest, true, { mail: true });
    expect(isEnabled(manifest, await loadModuleStates(h.db))).toBe(true);
  });

  it("Impressum (Q5-22): Felder nach § 5 DDG, Vollständigkeit, Formatprüfung", async () => {
    // Demo-Seed bringt ein vollständiges Impressum mit
    const demo = await readImpressum(h.db);
    expect(demo.complete).toBe(true);
    expect(demo.fields.name).toBe("Gesamtschule am Lindenhof");

    const partial = await saveImpressum(h.db, "u-admin", { name: "  Gesamtschule   am Lindenhof ", street: "Lindenweg 1", email: "" });
    expect(partial.fields.name).toBe("Gesamtschule am Lindenhof");
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(["Rechtsform", "Postleitzahl", "Ort", "Vertreten durch", "E-Mail-Adresse", "Telefon"]);
    expect(missingImpressumFields(EMPTY_IMPRESSUM)).toHaveLength(8);
    await expect(assertImpressumComplete(h.db)).rejects.toMatchObject({ fieldErrors: { verfahren: /fehlt: Rechtsform/ } });

    await expect(saveImpressum(h.db, "u-admin", { postalCode: "1234", email: "kein-at", phone: "abc" })).rejects.toMatchObject({
      fieldErrors: { postalCode: expect.any(String), email: expect.any(String), phone: expect.any(String) },
    });
    await expect(saveImpressum(h.db, "u-admin", { additional: "x".repeat(2001) })).rejects.toBeInstanceOf(ValidationError);
    // mehrzeilig nur in „Weitere Angaben“
    const ml = await saveImpressum(h.db, "u-admin", { ...demo.fields, additional: "Zeile 1\r\nZeile 2" });
    expect(ml.fields.additional).toBe("Zeile 1\nZeile 2");
    expect(ml.complete).toBe(true);
    await assertImpressumComplete(h.db);
  });

  it("Impressum (Q5-22): bisheriger Freitext bleibt, bis die Pflichtfelder vollständig sind", async () => {
    await h.db.delete(appSettings).where(eq(appSettings.key, IMPRESSUM_FIELDS_KEY));
    await h.db.insert(appSettings).values({ key: IMPRESSUM_LEGACY_KEY, value: "Gesamtschule am Lindenhof\nLindenweg 1" });
    const before = await readImpressum(h.db);
    expect(before).toMatchObject({ complete: false, legacyText: "Gesamtschule am Lindenhof\nLindenweg 1" });
    expect(before.fields).toEqual(EMPTY_IMPRESSUM);

    // unvollständig gespeichert → Freitext bleibt
    await saveImpressum(h.db, "u-admin", { name: "Gesamtschule am Lindenhof", street: "Lindenweg 1" });
    expect((await readImpressum(h.db)).legacyText).toBe("Gesamtschule am Lindenhof\nLindenweg 1");

    // vollständig → Freitext entfernt, Audit vermerkt es
    const full = { name: "Gesamtschule am Lindenhof", legalForm: "öffentliche Schule", street: "Lindenweg 1", postalCode: "12345", city: "Musterstadt", representedBy: "Petra Lindner", email: "info@schule.example.org", phone: "0123 4567" };
    const after = await saveImpressum(h.db, "u-admin", full);
    expect(after).toMatchObject({ complete: true, legacyText: "", missing: [] });
    const [row] = await h.db.select().from(appSettings).where(eq(appSettings.key, IMPRESSUM_LEGACY_KEY));
    expect(row).toBeUndefined();
    const logs = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.schule.impressum"));
    expect(logs.some((l) => (l.meta as Record<string, unknown> | null)?.freitext_entfernt === true)).toBe(true);
  });
});
