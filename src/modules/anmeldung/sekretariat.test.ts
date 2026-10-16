import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, auditLog, mailOutbox, notifications, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { confirmAntrag, formStamp, submitAntrag } from "./public";
import { addNote, dayList, getAntrag, gongNewAntrag, listAntraege, moveSlot, primarySchools, widgetSummary } from "./sekretariat";
import { addSlots, createVerfahren, listSlots, publishVerfahren } from "./service";

const now = new Date("2027-02-05T10:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);

describe("Schulanmeldung im Sekretariat (P4-36)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  let slots: string[];
  let n = 0;

  const submit = async (first: string, last: string, school: string, slotId: string, opts: { sibling?: boolean; confirm?: boolean } = {}) => {
    const email = `${first.toLowerCase()}@example.org`;
    const r = await submitAntrag(
      h.db,
      vid,
      {
        childFirstName: first,
        childLastName: last,
        childBirthDate: "2016-05-01",
        primarySchool: school,
        parent1Name: `Eltern ${last}`,
        parent1Email: email,
        parent1Phone: "0201 12345",
        addressStreet: "Weg 1",
        addressZip: "12345",
        addressCity: "Stadt",
        consent: "on",
        slotId,
        ...(opts.sibling ? { sibling: "on", siblingNote: "Tom, 7b" } : {}),
        stamp: formStamp(vid, at(-10_000)),
      },
      { ip: `10.2.0.${++n}`, now, school: "Lindenhof", state: "NW" },
    );
    expect(r).toEqual({ ok: true });
    if (opts.confirm === false) return email;
    const [m] = await h.db.select().from(mailOutbox).where(and(eq(mailOutbox.to, email), eq(mailOutbox.purpose, "anmeldung-bestaetigen")));
    const token = /\/anmeldung\/bestaetigen\/([A-Za-z0-9_-]{43})/.exec(m!.text)![1]!;
    expect((await confirmAntrag(h.db, token, { ip: `10.2.1.${n}`, now: at(60_000), school: "Lindenhof", state: "NW" })).state).toBe("ok");
    return email;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    jana = await loadPermissions(h.db, "u-jana.brandt");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10", "2027-02-11"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, at(-3_600_000));
    slots = (await listSlots(h.db, vid, now)).map((s) => s.id);
    await submit("Zoe", "Ärmel", "GS Nord", slots[0]!, { sibling: true });
    await submit("Anton", "Zander", "GS Süd", slots[2]!);
    await submit("Ida", "Becker", "GS Nord", slots[0]!);
    await submit("Unbe", "Staetigt", "GS Süd", slots[1]!, { confirm: false });
  });
  afterAll(async () => h?.close());

  it("Liste: unbestätigte nur auf Wunsch, deutsch sortiert (Ä bei A), Filter und Suche", async () => {
    const all = await listAntraege(h.db, sabine, vid);
    expect(all.map((a) => a.childLastName)).toEqual(["Ärmel", "Becker", "Zander"]);
    expect((await listAntraege(h.db, sabine, vid, { status: "unbestaetigt" })).map((a) => a.childLastName)).toEqual(["Staetigt"]);
    expect((await listAntraege(h.db, sabine, vid, { school: "gs nord" })).map((a) => a.childFirstName)).toEqual(["Zoe", "Ida"]);
    expect((await listAntraege(h.db, sabine, vid, { sibling: "ja" })).map((a) => a.childFirstName)).toEqual(["Zoe"]);
    expect((await listAntraege(h.db, sabine, vid, { slotId: slots[2] })).map((a) => a.childFirstName)).toEqual(["Anton"]);
    expect((await listAntraege(h.db, sabine, vid, { q: "eltern zander" })).map((a) => a.childFirstName)).toEqual(["Anton"]);
    expect((await listAntraege(h.db, sabine, vid, { q: all[1]!.number })).map((a) => a.childFirstName)).toEqual(["Ida"]);
    expect((await listAntraege(h.db, sabine, vid, { sort: "termin" })).at(-1)!.childFirstName).toBe("Anton");
    expect(await primarySchools(h.db, sabine, vid)).toEqual(["GS Nord", "GS Süd"]);
    // Schulleitung liest, Lehrkräfte nicht
    expect(await listAntraege(h.db, petra, vid)).toHaveLength(3);
    await expect(listAntraege(h.db, jana, vid)).rejects.toThrow(/anmeldung.view/);
  });

  it("Antrag öffnen: Lesezugriff protokolliert, ohne Token-Hashes; Notiz nur mit manage", async () => {
    const [a] = await listAntraege(h.db, sabine, vid);
    const r = await getAntrag(h.db, sabine, a!.id, now);
    expect(r!.antrag).not.toHaveProperty("confirmTokenHash");
    expect(r!.antrag).not.toHaveProperty("accessTokenHash");
    expect(r!.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["eingegangen", "bestaetigt"]));
    const [log] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "lesen.anmeldung"), eq(auditLog.target, a!.id)));
    expect(log).toMatchObject({ actorId: sabine.userId });
    await expect(getAntrag(h.db, jana, a!.id)).rejects.toThrow();
    await addNote(h.db, sabine, a!.id, "Bringt Zeugnis nach.", at(120_000));
    await expect(addNote(h.db, sabine, a!.id, "  ")).rejects.toMatchObject({ fieldErrors: { note: expect.any(String) } });
    await expect(addNote(h.db, sabine, a!.id, "x".repeat(1001))).rejects.toMatchObject({ fieldErrors: { note: /1000/ } });
    await expect(addNote(h.db, petra, a!.id, "x")).rejects.toThrow(/anmeldung.manage/);
    expect((await getAntrag(h.db, sabine, a!.id))!.events[0]).toMatchObject({ kind: "notiz", text: "Bringt Zeugnis nach.", actorName: expect.any(String) });
  });

  it("Termin verschieben: Platzprüfung, Mail an die Eltern, Verlauf; ohne Termin zurück auf „eingegangen“", async () => {
    const [zoe] = await listAntraege(h.db, sabine, vid, { q: "zoe" });
    await moveSlot(h.db, sabine, zoe!.id, slots[3]!, { now, school: "Lindenhof" });
    const [after] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, zoe!.id));
    expect(after).toMatchObject({ slotId: slots[3], status: "termin" });
    const mails = await h.db.select().from(mailOutbox).where(and(eq(mailOutbox.to, "zoe@example.org"), eq(mailOutbox.purpose, "anmeldung-termin")));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("Sekretariat");
    // voller Termin: Anton (slots[2]) + zwei weitere wären zu viel
    await moveSlot(h.db, sabine, (await listAntraege(h.db, sabine, vid, { q: "ida" }))[0]!.id, slots[2]!, { now, school: "L" });
    await expect(moveSlot(h.db, sabine, zoe!.id, slots[2]!, { now, school: "L" })).rejects.toMatchObject({ fieldErrors: { slotId: /ausgebucht/ } });
    await moveSlot(h.db, sabine, zoe!.id, null, { now, school: "L" });
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, zoe!.id)))[0]).toMatchObject({ slotId: null, status: "eingegangen" });
    await expect(moveSlot(h.db, petra, zoe!.id, slots[3]!, { now, school: "L" })).rejects.toThrow(/anmeldung.manage/);
  });

  it("Tagesliste und Widget", async () => {
    const day = await dayList(h.db, sabine, vid, "2027-02-11", now);
    expect(day).toHaveLength(2);
    expect(day[0]!.antraege.map((a) => a.child)).toEqual(["Becker, Ida", "Zander, Anton"]);
    expect(day[0]!.antraege[0]).toMatchObject({ parent: "Eltern Becker", phone: "0201 12345" });
    expect(day[1]!.antraege).toEqual([]);
    const w = await widgetSummary(h.db, sabine, "2027-02-11");
    expect(w).toEqual([expect.objectContaining({ id: vid, open: 3, today: 2 })]);
    await expect(dayList(h.db, jana, vid, "2027-02-11")).rejects.toThrow();
  });

  it("Gong gesammelt: ein ungelesener Gong je Verfahren mit Anzahl, ohne Namen", async () => {
    const mine = () => h.db.select().from(notifications).where(and(eq(notifications.userId, sabine.userId), eq(notifications.moduleId, "anmeldung")));
    // die drei Bestätigungen oben haben schon gesammelt
    expect((await mine()).map((x) => x.title)).toEqual(["3 neue Anmeldungen"]);
    await h.db.update(notifications).set({ readAt: now }).where(eq(notifications.userId, sabine.userId));
    await gongNewAntrag(h.db, vid);
    const list = await mine();
    expect(list.filter((x) => !x.readAt).map((x) => x.title)).toEqual(["1 neue Anmeldung"]);
    expect(JSON.stringify(list)).not.toMatch(/Zoe|Ärmel|Becker/);
    // Lehrkräfte bekommen nichts
    expect(await h.db.select().from(notifications).where(and(eq(notifications.userId, jana.userId), eq(notifications.moduleId, "anmeldung")))).toHaveLength(0);
  });
});
