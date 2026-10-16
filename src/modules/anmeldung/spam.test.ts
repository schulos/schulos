// P4-78: Sammel-Ablehnung „Spam“ aus der Antragsliste; P4-78b: zweistufig (Sekretariat markiert, Schulleitung bestätigt).
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, auditLog, mailOutbox, parentChild, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { decide, decisionList, exportSerienbriefCsv, exportSvsCsv, markSpamSuspect, rejectAsSpam, SPAM_NOTE, unmarkSpamSuspect } from "./entscheidung";
import { listAntraege } from "./sekretariat";
import { addSlots, createVerfahren, insertAntrag, publishVerfahren } from "./service";

const now = new Date("2027-02-20T10:00:00Z");

describe("Schulanmeldung – Sammel-Ablehnung „Spam“ (P4-78)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let vid: string;
  const ids: Record<string, string> = {};

  const add = async (first: string, status: "eingegangen" | "unbestaetigt" = "eingegangen", parentUserId: string | null = null) => {
    const r = await insertAntrag(
      h.db,
      vid,
      {
        childFirstName: first,
        childLastName: "Muster",
        childBirthDate: "2016-04-03",
        primarySchool: "GS Süd",
        sibling: false,
        siblingNote: null,
        parent1Name: `Eltern ${first}`,
        parent1Email: `${first.toLowerCase()}@example.org`,
        parent1Phone: "0201 1",
        addressStreet: "Weg 1",
        addressZip: "45127",
        addressCity: "Essen",
      },
      { status, now, parentUserId },
    );
    ids[first] = r.id;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
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
    for (const n of ["Bot1", "Bot2", "Bot3", "Echt"]) await add(n);
    await add("Offen", "unbestaetigt");
  }, 60_000);
  afterAll(async () => h?.close());

  it("nur mit Entscheidungsrecht; nur offene, bestätigte Anträge – sonst ändert sich nichts", async () => {
    await expect(rejectAsSpam(h.db, sabine, vid, [ids.Bot1!], now)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(rejectAsSpam(h.db, petra, vid, [], now)).rejects.toBeInstanceOf(ValidationError);
    await expect(rejectAsSpam(h.db, petra, vid, [ids.Bot1!, ids.Offen!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /E-Mail nicht bestätigt/ } });
    await expect(rejectAsSpam(h.db, petra, "anderes", [ids.Bot1!], now)).rejects.toBeInstanceOf(ValidationError);
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Bot1!)))[0]!.status).toBe("eingegangen");
  });

  it("lehnt die Auswahl in einem Schritt ab: Grund „Spam“, keine Mail, Verlauf, ein Audit-Eintrag ohne Namen", async () => {
    expect(await rejectAsSpam(h.db, petra, vid, [ids.Bot1!, ids.Bot2!, ids.Bot3!, ids.Bot1!], now)).toBe(3);
    const rows = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.verfahrenId, vid));
    const bots = rows.filter((r) => r.childFirstName.startsWith("Bot"));
    expect(bots.every((r) => r.status === "abgelehnt" && r.rejectedAsSpam && r.decisionNote === SPAM_NOTE && r.decidedBy === petra.userId)).toBe(true);
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "anmeldung-entscheidung"))).toHaveLength(0);
    const ev = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, ids.Bot1!), eq(anmeldungEreignisse.kind, "notiz")));
    expect(ev.map((e) => e.text)).toEqual(["Als Spam abgelehnt – keine Mail an die angegebene Adresse"]);
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.spam"));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorId: petra.userId, target: vid, meta: { anzahl: 3 } });
    expect(JSON.stringify(log)).not.toMatch(/Bot|Muster/);
    expect((await listAntraege(h.db, sabine, vid)).filter((a) => a.spam).map((a) => a.childFirstName).sort()).toEqual(["Bot1", "Bot2", "Bot3"]);
    // schon abgelehnt → kein zweites Mal
    await expect(rejectAsSpam(h.db, petra, vid, [ids.Bot1!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /Abgelehnt/ } });
  });

  it("Spam erscheint weder im Serienbrief noch im Export; eine echte Entscheidung danach schickt die Mail", async () => {
    await decide(h.db, petra, vid, [ids.Echt!], "abgelehnt", { school: "Lindenhof", now });
    const brief = new TextDecoder().decode((await exportSerienbriefCsv(h.db, petra, vid, "utf8", now)).body);
    expect(brief).toContain("Echt");
    expect(brief).not.toContain("Bot");
    const svs = new TextDecoder().decode((await exportSvsCsv(h.db, sabine, vid, { columns: ["vorname"], encoding: "utf8", scope: "entschieden" }, now)).body);
    expect(svs).not.toContain("Bot");
    // Irrtum: Bot3 war doch echt → Warteliste, Spam-Kennzeichen weg, Mail „Bescheid folgt per Post“
    expect(await decide(h.db, petra, vid, [ids.Bot3!], "warteliste", { school: "Lindenhof", now })).toMatchObject({ changed: 1, mails: 1 });
    const [bot3] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Bot3!));
    expect(bot3).toMatchObject({ status: "warteliste", rejectedAsSpam: false });
  });

  it("P4-78b: Sekretariat markiert Spam-Verdacht (Stand bleibt, keine Mail, Verlauf, Audit) und nimmt zurück; Lehrkräfte nicht", async () => {
    for (const n of ["Spam1", "Spam2", "Echt2"]) await add(n);
    const jana = await loadPermissions(h.db, "u-jana.brandt");
    await expect(markSpamSuspect(h.db, jana, vid, [ids.Spam1!], now)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markSpamSuspect(h.db, sabine, vid, [ids.Spam1!, ids.Offen!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /E-Mail nicht bestätigt/ } });
    expect(await markSpamSuspect(h.db, sabine, vid, [ids.Spam1!, ids.Spam2!, ids.Echt2!], now)).toBe(3);
    // doppelt markieren zählt nicht
    expect(await markSpamSuspect(h.db, sabine, vid, [ids.Spam1!], now)).toBe(0);
    const marked = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Spam1!));
    expect(marked[0]).toMatchObject({ status: "eingegangen", rejectedAsSpam: false, spamSuspectedBy: sabine.userId });
    expect(marked[0]!.spamSuspectedAt).toEqual(now);
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "anmeldung-entscheidung"))).toHaveLength(2); // nur die echten Entscheidungen oben (Echt, Bot3)
    const ev = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, ids.Spam1!), eq(anmeldungEreignisse.kind, "notiz")));
    expect(ev.map((e) => e.text)).toEqual(["Als Spam-Verdacht markiert – die Schulleitung entscheidet"]);
    const log = await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.spam.verdacht"));
    expect(log).toMatchObject([{ actorId: sabine.userId, target: vid, meta: { anzahl: 3 } }]);
    expect(JSON.stringify(log)).not.toMatch(/Spam1|Muster/);
    // Liste und Filter zeigen den Verdacht
    expect((await listAntraege(h.db, sabine, vid, { status: "spamverdacht" })).map((a) => a.childFirstName).sort()).toEqual(["Echt2", "Spam1", "Spam2"]);
    expect((await decisionList(h.db, petra, vid)).rows.filter((r) => r.spamSuspect)).toHaveLength(3);
    // Irrtum: Echt2 zurücknehmen
    expect(await unmarkSpamSuspect(h.db, sabine, vid, [ids.Echt2!, ids.Echt2!], now)).toBe(1);
    expect(await unmarkSpamSuspect(h.db, sabine, vid, [ids.Echt2!], now)).toBe(0);
    expect((await listAntraege(h.db, sabine, vid, { status: "spamverdacht" })).map((a) => a.childFirstName).sort()).toEqual(["Spam1", "Spam2"]);
    await expect(unmarkSpamSuspect(h.db, jana, vid, [ids.Spam1!], now)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.spam.verdacht.zurueck"))).toHaveLength(1);
  });

  it("P4-78b: Schulleitung bestätigt gesammelt – abgelehnt wie bisher, Verdacht weg; eine echte Entscheidung hebt ihn ebenso auf", async () => {
    expect(await rejectAsSpam(h.db, petra, vid, [ids.Spam1!, ids.Spam2!], now)).toBe(2);
    const rows = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.verfahrenId, vid));
    const spam = rows.filter((r) => r.childFirstName.startsWith("Spam"));
    expect(spam.every((r) => r.status === "abgelehnt" && r.rejectedAsSpam && r.spamSuspectedAt === null && r.spamSuspectedBy === null)).toBe(true);
    expect(await listAntraege(h.db, sabine, vid, { status: "spamverdacht" })).toEqual([]);
    // markiert, dann doch Warteliste → Verdacht weg, Mail geht raus
    await markSpamSuspect(h.db, sabine, vid, [ids.Echt2!], now);
    expect(await decide(h.db, petra, vid, [ids.Echt2!], "warteliste", { school: "Lindenhof", now })).toMatchObject({ changed: 1, mails: 1 });
    const [echt2] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Echt2!));
    expect(echt2).toMatchObject({ status: "warteliste", spamSuspectedAt: null });
    // nicht mehr offen → markieren geht nicht
    await expect(markSpamSuspect(h.db, sabine, vid, [ids.Echt2!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /Warteliste/ } });
  });
  it("G4D-S04: Anträge aus einem Elternkonto sind nie Spam – weder markieren noch als Spam ablehnen; zurücknehmen geht", async () => {
    const [{ parentId }] = (await h.db.select({ parentId: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, "u-lea.schaefer"))) as [{ parentId: string }];
    await add("Konto", "eingegangen", parentId);
    await add("Frei");
    await expect(markSpamSuspect(h.db, sabine, vid, [ids.Frei!, ids.Konto!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /Elternkonto – bitte regulär entscheiden/ } });
    await expect(rejectAsSpam(h.db, petra, vid, [ids.Konto!], now)).rejects.toMatchObject({ fieldErrors: { antraege: /Elternkonto/ } });
    const [konto] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Konto!));
    expect(konto).toMatchObject({ status: "eingegangen", rejectedAsSpam: false, spamSuspectedAt: null });
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Frei!)))[0]!.spamSuspectedAt).toBeNull();
    // ein (vor dem Fix) markierter Konto-Antrag lässt sich zurücknehmen
    await h.db.update(anmeldungAntraege).set({ spamSuspectedAt: now, spamSuspectedBy: sabine.userId }).where(eq(anmeldungAntraege.id, ids.Konto!));
    expect(await unmarkSpamSuspect(h.db, sabine, vid, [ids.Konto!], now)).toBe(1);
  });

  it("G4D-C04: irrtümlich als Spam abgelehnt → „abgelehnt“ regulär: Kennzeichen weg, Mail, Verlauf, im Serienbrief", async () => {
    const before = (await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "anmeldung-entscheidung"))).length;
    expect(await decide(h.db, petra, vid, [ids.Bot1!], "abgelehnt", { school: "Lindenhof", note: "Plätze vergeben", now })).toEqual({ changed: 1, skipped: 0, mails: 1 });
    const [bot1] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Bot1!));
    expect(bot1).toMatchObject({ status: "abgelehnt", rejectedAsSpam: false, decisionNote: "Plätze vergeben" });
    expect(await h.db.select().from(mailOutbox).where(eq(mailOutbox.purpose, "anmeldung-entscheidung"))).toHaveLength(before + 1);
    const ev = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, ids.Bot1!), eq(anmeldungEreignisse.kind, "status")));
    expect(ev.map((e) => e.text)).toContain("Spam-Kennzeichen aufgehoben – regulär abgelehnt");
    const brief = new TextDecoder().decode((await exportSerienbriefCsv(h.db, petra, vid, "utf8", now)).body);
    expect(brief).toContain("Bot1");
    // ein zweites „abgelehnt“ ist wieder eine echte Wiederholung: übersprungen, keine Mail
    expect(await decide(h.db, petra, vid, [ids.Bot1!], "abgelehnt", { school: "Lindenhof", now })).toEqual({ changed: 0, skipped: 1, mails: 0 });
  });

  it("G4D-C06: Spam-Ablehnung als Liste ist atomar – scheitert ein Antrag, bleibt die ganze Auswahl unverändert", async () => {
    await add("Atom1");
    await add("Atom2");
    // Fehler beim zweiten Antrag erzwingen (wie „inzwischen geändert“ oder ein DB-Fehler mitten in der Liste)
    await h.db.execute(sql.raw("create function g4d_c06_fail() returns trigger language plpgsql as $$ begin raise exception 'Testfehler'; end $$"));
    await h.db.execute(
      sql.raw(`create trigger g4d_c06 before update on anmeldung_antraege for each row when (new.id = '${ids.Atom2}' and new.status = 'abgelehnt') execute function g4d_c06_fail()`),
    );
    await expect(rejectAsSpam(h.db, petra, vid, [ids.Atom1!, ids.Atom2!], now)).rejects.toThrow();
    await h.db.execute(sql.raw("drop trigger g4d_c06 on anmeldung_antraege"));
    await h.db.execute(sql.raw("drop function g4d_c06_fail()"));
    const rows = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.verfahrenId, vid));
    expect(rows.filter((r) => r.childFirstName.startsWith("Atom")).map((r) => [r.status, r.rejectedAsSpam])).toEqual([
      ["eingegangen", false],
      ["eingegangen", false],
    ]);
    expect(await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, ids.Atom1!), eq(anmeldungEreignisse.kind, "notiz")))).toEqual([]);
    expect(await rejectAsSpam(h.db, petra, vid, [ids.Atom1!, ids.Atom2!], now)).toBe(2);
  });
});
