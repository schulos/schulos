import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, auditLog, mailOutbox, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { decide, decisionList, exportSerienbriefCsv, exportSvsCsv } from "./entscheidung";
import { addSlots, closeVerfahren, completeVerfahren, createVerfahren, insertAntrag, publishVerfahren, setAntragStatus } from "./service";

const now = new Date("2027-02-20T10:00:00Z");
const decoder = (enc: string) => new TextDecoder(enc === "cp1252" ? "windows-1252" : "utf-8");

describe("Schulanmeldung – Entscheidung und Export (P4-37)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  const ids: Record<string, string> = {};

  const add = async (first: string, last: string, opts: { sibling?: string; zip?: string } = {}) => {
    const r = await insertAntrag(
      h.db,
      vid,
      {
        childFirstName: first,
        childLastName: last,
        childBirthDate: "2016-04-03",
        primarySchool: "GS Süd",
        sibling: Boolean(opts.sibling),
        siblingNote: opts.sibling ?? null,
        parent1Name: `Eltern ${last}`,
        parent1Email: `${first.toLowerCase()}@example.org`,
        parent1Phone: "=0201 1",
        addressStreet: "Weg 1",
        addressZip: opts.zip ?? "45127",
        addressCity: "Essen",
      },
      { status: "eingegangen", now },
    );
    ids[first] = r.id;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    jana = await loadPermissions(h.db, "u-jana.brandt");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, {
      name: "Klasse 5 – 2027/28",
      kind: "klasse5",
      targetSchoolYearId: "sj-2027-28",
      targetGradeLevel: 5,
      opensAt: "2027-02-01T08:00",
      closesAt: "2027-02-28T18:00",
      capacity: 2,
    });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, new Date("2027-01-31T10:00:00Z"));
    await add("Ömer", "Özdemir", { sibling: "Ali, 7b" });
    await add("Anna", "Adler");
    await add("Ben", "Bauer", { zip: "45130" });
    await add("Carla", "Czech");
  });
  afterAll(async () => h?.close());

  it("Liste: bestätigte Anträge, Hinweise nur als Information, Kapazität; Lehrkräfte nicht", async () => {
    const { rows, capacity } = await decisionList(h.db, petra, vid);
    expect(rows.map((r) => r.childLastName)).toEqual(["Adler", "Bauer", "Czech", "Özdemir"]);
    expect(rows.find((r) => r.childFirstName === "Ömer")).toMatchObject({ sibling: true, siblingNote: "Ali, 7b", zip: "45127", city: "Essen", documentsComplete: false });
    expect(capacity).toMatchObject({ capacity: 2, free: 2, undecided: 4 });
    await expect(decisionList(h.db, jana, vid)).rejects.toThrow(/anmeldung.view/);
  });

  it("Entscheiden als Liste: nur mit decide, Mail ohne Ergebnis nur beim ersten Mal, Korrektur ohne Mail, Audit", async () => {
    await expect(decide(h.db, sabine, vid, [ids.Anna!], "aufgenommen", { school: "Lindenhof", now })).rejects.toThrow(/anmeldung.decide/);
    await expect(decide(h.db, petra, vid, [], "aufgenommen", { school: "L", now })).rejects.toMatchObject({ fieldErrors: { antraege: expect.any(String) } });
    const r = await decide(h.db, petra, vid, [ids.Anna!, ids.Ömer!, ids.Ben!], "aufgenommen", { school: "Lindenhof", note: "Geschwisterkind", now });
    expect(r).toEqual({ changed: 3, skipped: 0, mails: 3 });
    // keine automatische Begrenzung: drei Aufnahmen bei zwei Plätzen sind möglich (Hinweis nur in der Oberfläche)
    expect((await decisionList(h.db, petra, vid)).capacity).toMatchObject({ free: -1, undecided: 1 });
    const [mail] = await h.db.select().from(mailOutbox).where(and(eq(mailOutbox.to, "anna@example.org"), eq(mailOutbox.purpose, "anmeldung-entscheidung")));
    expect(mail!.text).toContain("per Post");
    expect(mail!.text).not.toMatch(/aufgenommen|Anna|Adler/i);
    const [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Anna!));
    expect(a).toMatchObject({ status: "aufgenommen", decidedBy: petra.userId, decisionNote: "Geschwisterkind", retentionFrom: null });
    // Korrektur: Ben auf die Warteliste – keine zweite Mail
    expect(await decide(h.db, petra, vid, [ids.Ben!, ids.Anna!], "warteliste", { school: "L", now })).toEqual({ changed: 2, skipped: 0, mails: 0 });
    expect(await decide(h.db, petra, vid, [ids.Anna!], "aufgenommen", { school: "L", now })).toEqual({ changed: 1, skipped: 0, mails: 0 });
    expect(await decide(h.db, petra, vid, [ids.Anna!], "aufgenommen", { school: "L", now })).toEqual({ changed: 0, skipped: 1, mails: 0 });
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "anmeldung-entscheidung"))).toHaveLength(3);
    const events = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, ids.Ben!), eq(anmeldungEreignisse.kind, "status")));
    expect(events.map((e) => e.text)).toEqual(expect.arrayContaining(["Eingegangen → Aufgenommen", "Aufgenommen → Warteliste"]));
    const logs = await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.entscheidung.liste"));
    expect(logs[0]).toMatchObject({ actorId: petra.userId, target: vid, meta: { nach: "aufgenommen", anzahl: 3 } });
    expect(JSON.stringify(logs)).not.toMatch(/Anna|Adler/);
  });

  it("Liste wird vorab geprüft: ein unmöglicher Übergang ändert nichts, fremde Verfahren nicht", async () => {
    await setAntragStatus(h.db, sabine, ids.Carla!, "zurueckgezogen", { now });
    await expect(decide(h.db, petra, vid, [ids.Ömer!, ids.Carla!], "abgelehnt", { school: "L", now })).rejects.toMatchObject({ fieldErrors: { antraege: /Zurückgezogen/ } });
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Ömer!)))[0]!.status).toBe("aufgenommen");
    await expect(decide(h.db, petra, "anderes", [ids.Ömer!], "abgelehnt", { school: "L", now })).rejects.toThrow();
  });

  it("Export Schulverwaltungssoftware: Spaltenwahl in fester Reihenfolge, nur Aufgenommene, Kodierung, Formel-Schutz, Protokoll", async () => {
    await expect(exportSvsCsv(h.db, petra, vid, { columns: ["nachname"], encoding: "utf8", scope: "aufgenommen" })).rejects.toThrow(/anmeldung.manage/);
    await expect(exportSvsCsv(h.db, sabine, vid, { columns: ["unbekannt"], encoding: "utf8", scope: "aufgenommen" })).rejects.toMatchObject({ fieldErrors: { columns: expect.any(String) } });
    const r = await exportSvsCsv(h.db, sabine, vid, { columns: ["telefon", "vorname", "nachname", "geburtsdatum"], encoding: "utf8", scope: "aufgenommen" }, now);
    const text = decoder("utf8").decode(r.body);
    expect(text.split("\r\n").slice(0, 3)).toEqual(["Nachname;Vorname;Geburtsdatum;Telefon", "Adler;Anna;03.04.2016;'=0201 1", "Özdemir;Ömer;03.04.2016;'=0201 1"]);
    expect(r).toMatchObject({ count: 2, filename: "anmeldung-klasse-5-2027-28-2027-02-20.csv" });
    expect([...r.body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const cp = await exportSvsCsv(h.db, sabine, vid, { columns: ["nachname"], encoding: "cp1252", scope: "entschieden" }, now);
    expect(cp.body[0]).not.toBe(0xef);
    expect(decoder("cp1252").decode(cp.body).split("\r\n")).toEqual(["Nachname", "Adler", "Bauer", "Özdemir", ""]);
    expect(cp.body.includes(0xd6)).toBe(true); // „Ö“ als ein Byte
    const [log] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "anmeldung.export.svs"), eq(auditLog.actorId, sabine.userId)));
    expect(log!.meta).toMatchObject({ anzahl: 2, spalten: 4, kodierung: "utf8", auswahl: "aufgenommen" });
  });

  it("Serienbrief: entschiedene Anträge mit Anschrift und Entscheidung; Schulleitung darf, Lehrkräfte nicht", async () => {
    const r = await exportSerienbriefCsv(h.db, petra, vid, "utf8", now);
    const lines = decoder("utf8").decode(r.body).replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Vorgangsnummer;Entscheidung;Empfänger;Elternteil 2;Straße;PLZ;Ort;Kind Vorname;Kind Nachname;Geburtsdatum;Entschieden am");
    expect(lines.slice(1, -1).map((l) => l.split(";").slice(1, 3).join("|"))).toEqual(["Aufgenommen|Eltern Adler", "Aufgenommen|Eltern Özdemir", "Warteliste|Eltern Bauer"]);
    await expect(exportSerienbriefCsv(h.db, jana, vid, "utf8")).rejects.toThrow();
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.export.serienbrief"))).toHaveLength(1);
  });

  it("Abschließen: nur geschlossen und ohne offene Anträge, danach keine Entscheidungen mehr; Löschfrist für die Warteliste", async () => {
    await expect(completeVerfahren(h.db, petra, vid, now)).rejects.toMatchObject({ fieldErrors: { verfahren: /schließen/ } });
    await closeVerfahren(h.db, sabine, vid, now);
    await completeVerfahren(h.db, petra, vid, now);
    await expect(decide(h.db, petra, vid, [ids.Ben!], "abgelehnt", { school: "L", now })).rejects.toMatchObject({ fieldErrors: { verfahren: /abgeschlossen/ } });
    await expect(decide(h.db, petra, vid, [ids.Anna!], "warteliste", { school: "L", now })).rejects.toMatchObject({ fieldErrors: { verfahren: /abgeschlossen/ } });
    const [ben] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Ben!));
    expect(ben!.retentionFrom).not.toBeNull();
  });

  it("Q5-19: Nachrücken von der Warteliste nach Abschluss – nur Schulleitung, nur bis Schuljahresbeginn, ohne Mail", async () => {
    await expect(decide(h.db, sabine, vid, [ids.Ben!], "aufgenommen", { school: "L", now })).rejects.toThrow(/anmeldung.decide/);
    // gemischt mit einem schon Aufgenommenen geht (wird übersprungen), mit einem anderen Stand nicht
    await expect(decide(h.db, petra, vid, [ids.Ben!, ids.Carla!], "aufgenommen", { school: "L", now })).rejects.toMatchObject({ fieldErrors: { verfahren: /Warteliste/ } });
    await expect(decide(h.db, petra, vid, [ids.Ben!], "aufgenommen", { school: "L", now: new Date("2027-08-01T08:00:00Z") })).rejects.toMatchObject({
      fieldErrors: { verfahren: /Beginn des Schuljahres/ },
    });
    expect(await decide(h.db, petra, vid, [ids.Ben!, ids.Anna!], "aufgenommen", { school: "L", now })).toEqual({ changed: 1, skipped: 1, mails: 0 });
    const [ben] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Ben!));
    expect(ben).toMatchObject({ status: "aufgenommen", retentionFrom: null, decidedBy: petra.userId });
  });
});
