import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, auditLog, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { externalPathAllowed } from "@/core/external-access";
import { ForbiddenError, loadPermissions, type PermissionSet } from "@/core/permissions";
import { activeProcessingRecords } from "@/core/privacy/hinweise";
import { isPublicPath } from "@/core/public-paths";
import { antragAuskunft, canAuskunft, findAntraegeForAuskunft } from "./auskunft";
import { CHECKLIST_KEYS } from "./katalog";
import { addNote } from "./sekretariat";
import { addSlots, createVerfahren, insertAntrag, listSlots, publishVerfahren, setChecklist } from "./service";

// P4-42: Auskunft (Art. 15) zu Anträgen ohne Konto – per Vorgangsnummer/E-Mail durch das Sekretariat, als JSON

const now = new Date("2027-02-05T10:00:00Z");

describe("Auskunft Schulanmeldung (P4-42)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  let antragId: string;
  let number: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    jana = await loadPermissions(h.db, "u-jana.brandt");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, new Date(now.getTime() - 3_600_000));
    const [slot] = await listSlots(h.db, vid, now);
    const base = { childBirthDate: "2016-05-01", primarySchool: "GS Nord", parent1Phone: "0201 12345", addressStreet: "Weg 1", addressZip: "12345", addressCity: "Stadt" };
    const r = await insertAntrag(
      h.db,
      vid,
      { ...base, childFirstName: "Zoe", childLastName: "Ärmel", parent1Name: "Eva Ärmel", parent1Email: "Eva.Aermel@example.org", slotId: slot!.id, hints: "Wir sind neu im Ort." },
      { now, status: "eingegangen", confirmTokenHash: "a".repeat(64) },
    );
    antragId = r.id;
    number = r.number;
    await h.db.update(anmeldungAntraege).set({ accessTokenHash: "b".repeat(64) }).where(eq(anmeldungAntraege.id, antragId));
    // zweites Kind derselben Familie, dritte Familie
    await insertAntrag(h.db, vid, { ...base, childFirstName: "Mia", childLastName: "Ärmel", parent1Name: "Eva Ärmel", parent1Email: "eva.aermel@example.org" }, { now, status: "eingegangen" });
    await insertAntrag(h.db, vid, { ...base, childFirstName: "Ben", childLastName: "Otto", parent1Name: "Ole Otto", parent1Email: "ole@example.org", parent2Name: "Udo Otto", parent2Email: "udo@example.org" }, { now });
    await setChecklist(h.db, sabine, antragId, { anmeldeschein: true, zeugnis: true }, CHECKLIST_KEYS, now);
    await addNote(h.db, sabine, antragId, "Zeugnis gesehen.", now);
  });
  afterAll(async () => h?.close());

  it("Sekretariat und Datenschutz dürfen, Lehrkräfte nicht", async () => {
    expect(canAuskunft(sabine)).toBe(true);
    expect(canAuskunft(petra)).toBe(true); // verwaltung.* (Datenschutz) über die Schulleitung
    expect(canAuskunft(jana)).toBe(false);
    await expect(findAntraegeForAuskunft(h.db, jana, number)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(antragAuskunft(h.db, jana, antragId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("findet per Vorgangsnummer (genau) und E-Mail (ohne Groß/Klein, Elternteil 1) – keine Teilsuche", async () => {
    expect((await findAntraegeForAuskunft(h.db, sabine, number)).map((t) => t.id)).toEqual([antragId]);
    expect((await findAntraegeForAuskunft(h.db, sabine, number.toLowerCase())).map((t) => t.id)).toEqual([antragId]);
    const family = await findAntraegeForAuskunft(h.db, sabine, "EVA.aermel@example.org");
    expect(family.map((t) => t.childName).sort()).toEqual(["Mia Ärmel", "Zoe Ärmel"]);
    // unbestätigte Anträge auch (sie sind gespeichert)
    expect(await findAntraegeForAuskunft(h.db, sabine, "ole@example.org")).toHaveLength(1);
    // Q5-23: auch per Adresse des zweiten Elternteils (eigenes Auskunftsrecht)
    const udo = await findAntraegeForAuskunft(h.db, sabine, "UDO@example.org");
    expect(udo.map((t) => t.childName)).toEqual(["Ben Otto"]);
    // GATE-031 S-02: gekennzeichnet, eingeschränkte Auskunft ohne Elternteil 1, Anschrift, Hinweise, Kind
    expect(udo[0]!.via).toBe("elternteil2");
    expect((await findAntraegeForAuskunft(h.db, sabine, "ole@example.org"))[0]!.via).toBe("elternteil1");
    expect((await findAntraegeForAuskunft(h.db, sabine, number))[0]!.via).toBe("vorgangsnummer");
    const lim = (await antragAuskunft(h.db, sabine, udo[0]!.id, { now, umfang: "elternteil2" }))!;
    expect(lim.filename).toMatch(/elternteil2.json$/);
    expect(lim.data).toMatchObject({ antrag: { elternteil2: { name: "Udo Otto", email: "udo@example.org" } } });
    const text = JSON.stringify(lim.data);
    for (const x of ["Ole", "ole@example.org", "0201 12345", "Weg 1", "Ben", "2016-05-01", "GS Nord"]) expect(text, x).not.toContain(x);
    // ohne zweiten Elternteil gibt es keine eingeschränkte Auskunft
    expect(await antragAuskunft(h.db, sabine, antragId, { now, umfang: "elternteil2" })).toBeNull();
    for (const q of ["aermel", "@example.org", "Ärmel", "A-2027", "A-2027-9999", "", "%"]) expect(await findAntraegeForAuskunft(h.db, sabine, q), q).toEqual([]);
  });

  it("GATE-031 R-05: Umfang folgt serverseitig aus dem Suchbegriff, nicht aus dem Formularfeld", async () => {
    const [ben] = await findAntraegeForAuskunft(h.db, sabine, "udo@example.org");
    expect(ben!.hasParent2).toBe(true);
    // über Elternteil 2 gefunden → eingeschränkt, auch wenn „voll“ verlangt wird
    const forced = (await antragAuskunft(h.db, sabine, ben!.id, { now, query: "UDO@example.org", umfang: "voll" }))!;
    expect(forced.filename).toMatch(/elternteil2\.json$/);
    expect(JSON.stringify(forced.data)).not.toContain("ole@example.org");
    // über Elternteil 1 → voll, auch wenn „elternteil2“ geschickt wird
    expect((await antragAuskunft(h.db, sabine, ben!.id, { now, query: "ole@example.org", umfang: "elternteil2" }))!.filename).not.toMatch(/elternteil2/);
    // Vorgangsnummer: ausdrückliche Wahl
    expect((await antragAuskunft(h.db, sabine, ben!.id, { now, query: ben!.number, umfang: "elternteil2" }))!.filename).toMatch(/elternteil2\.json$/);
    expect((await antragAuskunft(h.db, sabine, ben!.id, { now, query: ben!.number }))!.filename).not.toMatch(/elternteil2/);
    // Suchbegriff passt nicht zum Antrag → nichts
    expect(await antragAuskunft(h.db, sabine, ben!.id, { now, query: "eva.aermel@example.org" })).toBeNull();
    expect(await antragAuskunft(h.db, sabine, ben!.id, { now, query: number })).toBeNull();
    // Audit hält Umfang und Anlass fest
    const rows = await h.db.select().from(auditLog).where(eq(auditLog.target, ben!.id));
    expect(rows.map((r) => r.meta)).toContainEqual(expect.objectContaining({ umfang: "elternteil2", anlass: "elternteil2" }));
    expect(rows.map((r) => r.meta)).toContainEqual(expect.objectContaining({ umfang: "voll", anlass: "elternteil1" }));
  });

  it("JSON: alle Angaben, Termin, Unterlagen, Verlauf – ohne Token-Hashes, ohne Namen von Beschäftigten", async () => {
    const r = await antragAuskunft(h.db, sabine, antragId, { now, state: "NW", school: "Lindenhof" });
    expect(r?.filename).toBe(`auskunft-${number}.json`);
    const d = r!.data as {
      antrag: Record<string, unknown> & { kind: Record<string, unknown>; eltern: Record<string, unknown>; unterlagenVorgelegt: { vorgelegt: boolean }[]; termin: unknown };
      verlauf: { art: string; durch: string; text: string }[];
      verfahren: { name: string };
    };
    expect(d.verfahren.name).toBe("Klasse 5");
    expect(d.antrag).toMatchObject({ vorgangsnummer: number, stand: "Termin vereinbart", hinweiseFuerDasGespraech: "Wir sind neu im Ort.", ueberElternkonto: false });
    expect(d.antrag.kind).toMatchObject({ vorname: "Zoe", nachname: "Ärmel", geburtsdatum: "2016-05-01", grundschule: "GS Nord" });
    expect(d.antrag.eltern).toMatchObject({ name: "Eva Ärmel", email: "Eva.Aermel@example.org", telefon: "0201 12345" });
    expect(d.antrag.termin).not.toBeNull();
    expect(d.antrag.unterlagenVorgelegt.filter((u) => u.vorgelegt)).toHaveLength(2);
    expect(d.verlauf.find((e) => e.art === "notiz")).toMatchObject({ text: "Zeugnis gesehen.", durch: "Schule" });
    const json = JSON.stringify(r!.data);
    for (const secret of ["a".repeat(64), "b".repeat(64), "u-sabine.kowalski", "Kowalski", "Sabine", "Hash", "token"]) expect(json).not.toContain(secret);
    // anderes Kind derselben Familie gehört nicht hinein
    expect(json).not.toContain("Mia");
    expect(await antragAuskunft(h.db, sabine, "gibt-es-nicht")).toBeNull();
  });

  it("Audit: Suche und Auskunft protokolliert – ohne Personendaten", async () => {
    const rows = await h.db.select().from(auditLog).where(like(auditLog.action, "anmeldung.auskunft%"));
    expect(rows.some((r) => r.action === "anmeldung.auskunft" && r.target === antragId)).toBe(true);
    expect(rows.some((r) => r.action === "anmeldung.auskunft.suche" && (r.meta as { art: string }).art === "email")).toBe(true);
    const text = JSON.stringify(rows);
    for (const p of ["example.org", "Ärmel", "Zoe", number]) expect(text).not.toContain(p);
  });
});

describe("Schulanmeldung öffentlich: Pfade und Datenschutzhinweis (S30, S35, P4-42)", () => {
  it("öffentliche Seiten = ohne Anmeldung und von außen erreichbar; Export und Auskunft weder noch", () => {
    for (const p of ["/anmeldung", "/anmeldung/x", "/anmeldung/bestaetigen/t", "/anmeldung/vorgang/t", "/anmeldung/vorgang/t/termin.ics", "/impressum", "/datenschutzhinweise"]) {
      expect(isPublicPath(p), p).toBe(true);
      expect(externalPathAllowed(p), p).toBe(true);
    }
    for (const p of ["/api/verwaltung/anmeldung-export/v/svs", "/api/verwaltung/anmeldung-auskunft/a", "/verwaltung/anmeldung/auskunft", "/schulanmeldung", "/druck/anmeldung/a"]) {
      expect(isPublicPath(p), p).toBe(false);
      expect(externalPathAllowed(p), p).toBe(false);
    }
  });

  it("Datenschutzhinweis und VVT enthalten die Schulanmeldung, sobald das Modul an ist", async () => {
    const h = await createSeededTestDb();
    try {
      const record = (await activeProcessingRecords(h.db)).find((r) => r.title.startsWith("Schulanmeldung"));
      expect(record).toBeDefined();
      expect(JSON.stringify(record)).toContain("§ 46 SchulG NRW");
    } finally {
      await h.close();
    }
  });
});
