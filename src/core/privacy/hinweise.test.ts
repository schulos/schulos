import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { setModuleEnabled } from "@/core/modules/registry";
import { ValidationError } from "@/modules/verwaltung/users";
import { getModule, MODULES } from "@/modules";
import { activeProcessingRecords, LEGAL_BASIS_SCHOOL, legalBasisWarning, missingTexts, processingRecords, readPrivacyTexts, savePrivacyTexts } from "./hinweise";

describe("Verarbeitungstätigkeiten aus den Manifesten", () => {
  it("jedes Modul mit Personendaten beschreibt seine Verarbeitung", () => {
    const missing = MODULES.filter((m) => (m.retention ?? []).length > 0 && !m.processing).map((m) => m.id);
    expect(missing).toEqual([]);
    for (const m of MODULES.filter((x) => x.processing)) {
      const p = m.processing!;
      expect(p.purpose.length, m.id).toBeGreaterThan(10);
      expect(p.subjects.length, m.id).toBeGreaterThan(0);
      expect(p.recipients.length, m.id).toBeGreaterThan(0);
    }
  });

  it("Grundsystem zuerst; Datenarten mit Fristen, Folgetabellen erben die Frist", () => {
    const recs = processingRecords(MODULES);
    expect(recs[0]!.id).toBe("core");
    const kb = recs.find((r) => r.id === "klassenbuch")!;
    expect(kb.dataTypes.map((d) => d.purpose)).toEqual(["Klassenbuch führen (Unterrichtsinhalte, Hausaufgaben)", "Fehlzeiten und Verspätungen erfassen"]);
    expect(kb.dataTypes[1]!.retention).toBe(kb.dataTypes[0]!.retention);
    expect(recs.find((r) => r.id === "abwesenheiten")!.legalBasis).toMatch(/Art\. 9/);
    expect(recs.find((r) => r.id === "news")!.legalBasis).toMatch(/SchulG NRW/);
    // Plattform-Grundlage ausdrücklich
    expect(LEGAL_BASIS_SCHOOL).toMatch(/§ 120 Abs\. 1 und 5, § 121 Abs\. 1, § 8 Abs\. 2 SchulG NRW/);
    // DS-17: § 122 Abs. 1 Satz 2 (Art. 9 Abs. 2 lit. g), VO-DV I Anlage 1 Ziff. 18/19.1, Beurlaubung § 43 Abs. 4
    const abw = recs.find((r) => r.id === "abwesenheiten")!.legalBasis;
    expect(abw).toMatch(/§ 43 Abs\. 2/);
    expect(abw).toMatch(/§ 122 Abs\. 1 Satz 2/);
    expect(abw).toMatch(/Ziff\. 19\.1/);
    expect(abw).toMatch(/Ziff\. 18/);
    expect(abw).toMatch(/Beurlaubung: § 43 Abs\. 4/);
    expect(abw).not.toMatch(/§ 43 Abs\. 3|zu prüfen/);
    expect(kb.legalBasis).toMatch(/Anlage 2 I Nr\. 1/);
    // § 122 nur zusammen mit Abs. 1 Satz 2, nie als bloße Verordnungsermächtigung
    expect(recs.every((r) => !r.legalBasis.includes("122") || r.legalBasis.includes("§ 122 Abs. 1 Satz 2"))).toBe(true);
  });

  it("außerhalb von NRW: Warnung, dass es für das Land keine ausgearbeitete Vorlage gibt", () => {
    expect(legalBasisWarning("NW")).toBeNull();
    expect(legalBasisWarning("BY")).toMatch(/nur für Schulen in Nordrhein-Westfalen freigegeben\. Für Bayern/);
  });
});

describe("Angaben der Schule", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values({ id: "x", name: "Admin", email: "x@example.org", role: "admin" });
  });
  afterAll(() => h.close());

  it("Vorgaben, Speichern mit Längenprüfung, fehlende Pflichtangaben", async () => {
    const t = await readPrivacyTexts(h.db);
    expect(t.authority).toMatch(/Nordrhein-Westfalen/);
    expect(missingTexts(t)).toEqual(["controller", "dpo", "operator"]);
    await expect(savePrivacyTexts(h.db, "x", { extra: "x".repeat(4001) })).rejects.toBeInstanceOf(ValidationError);
    await savePrivacyTexts(h.db, "x", { controller: "  Gesamtschule am Lindenhof\r\nLindenweg 1  ", dpo: "dsb@schule.example", operator: "Schulträger" });
    const back = await readPrivacyTexts(h.db);
    expect(back.controller).toBe("Gesamtschule am Lindenhof\nLindenweg 1");
    expect(missingTexts(back)).toEqual([]);
  });

  it("nur aktive Module erscheinen", async () => {
    await setModuleEnabled(h.db, getModule("messenger")!, false);
    const ids = (await activeProcessingRecords(h.db)).map((r) => r.id);
    expect(ids).not.toContain("messenger");
    expect(ids).toContain("klassenbuch");
  });
});
