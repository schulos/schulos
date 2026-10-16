import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "@/core/db/schema";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { defaultEnforcement, legalBasis, missingA11yFields, parseA11yStatement, readA11yStatement, saveA11yStatement } from "./barrierefreiheit";

describe("A11Y-02: Erklärung zur Barrierefreiheit", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => h.close());

  it("ohne Angaben: Vorgaben (teilweise vereinbar), Kontakt und Datum fehlen", async () => {
    const s = await readA11yStatement(h.db);
    expect(s.status).toBe("teilweise");
    expect(missingA11yFields(s)).toEqual(["Kontakt (E-Mail oder Telefon)", "Datum der Überprüfung"]);
  });

  it("speichern, lesen, Protokoll; ungültige Angaben werden abgelehnt", async () => {
    const saved = await saveA11yStatement(h.db, "u-admin", {
      status: "teilweise",
      contactName: "  Sekretariat  ",
      contactEmail: "sekretariat@schule.example",
      contactPhone: "",
      reviewedOn: "2026-10-14",
      extraBarriers: "Ältere Elternbriefe als eingescannte PDF\r\nohne Textebene",
      enforcement: "",
      unknown: "wird ignoriert",
    });
    expect(saved).toEqual({
      status: "teilweise",
      contactName: "Sekretariat",
      contactEmail: "sekretariat@schule.example",
      contactPhone: "",
      reviewedOn: "2026-10-14",
      extraBarriers: "Ältere Elternbriefe als eingescannte PDF\nohne Textebene",
      enforcement: "",
    });
    expect(await readA11yStatement(h.db)).toEqual(saved);
    expect(missingA11yFields(saved)).toEqual([]);
    const log = await h.db.select().from(auditLog);
    expect(log.some((l) => l.action === "verwaltung.schule.barrierefreiheit")).toBe(true);

    const err = await saveA11yStatement(h.db, "u-admin", { status: "toll", contactEmail: "keine-mail", contactPhone: "abc", reviewedOn: "14.10.2026" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["contactEmail", "contactPhone", "reviewedOn", "status"]);
    // Überlänge
    await expect(saveA11yStatement(h.db, "u-admin", { status: "nicht", extraBarriers: "x".repeat(3001) })).rejects.toMatchObject({
      fieldErrors: { extraBarriers: expect.any(String) },
    });
    expect((await readA11yStatement(h.db)).status).toBe("teilweise");
  });

  it("Rechtsgrundlage und Durchsetzungsverfahren je Bundesland", () => {
    expect(legalBasis("NW")).toContain("BITV NRW");
    expect(defaultEnforcement("NW")).toContain("Ombudsstelle für barrierefreie Informationstechnik");
    expect(defaultEnforcement("NW")).toContain("ombudsstelle-barrierefreie-it@mags.nrw.de");
    expect(legalBasis("BY")).toContain("Richtlinie (EU) 2016/2102");
    expect(defaultEnforcement("BY")).toContain("trägt die Stelle hier ein");
  });

  it("gespeicherte Werte werden streng gelesen", () => {
    expect(parseA11yStatement(null).status).toBe("teilweise");
    expect(parseA11yStatement({ status: "vollstaendig", reviewedOn: "gestern", contactEmail: 5 })).toMatchObject({
      status: "vollstaendig",
      reviewedOn: "",
      contactEmail: "",
    });
  });
});
