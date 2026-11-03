import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungLose, auditLog, mailOutbox, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { lotOrder } from "@/core/los";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { decide, decisionList, exportSvsCsv } from "./entscheidung";
import { applyLot, discardLot, drawLot, getLot, listLots, lotOutcome, lotsOfAntrag, prepareLot, repeatLot, seedHashOf, verifyLot } from "./los";
import { addSlots, createVerfahren, insertAntrag, publishVerfahren, setAntragStatus } from "./service";

const now = new Date("2027-02-20T10:00:00Z");

describe("Losverfahren bei Anmeldeüberhang (LO-01)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  let other: string;
  const ids: Record<string, string> = {};

  const add = async (verfahrenId: string, first: string) => {
    const r = await insertAntrag(
      h.db,
      verfahrenId,
      {
        childFirstName: first,
        childLastName: "Kind",
        childBirthDate: "2016-04-03",
        primarySchool: "GS Süd",
        parent1Name: `Eltern ${first}`,
        parent1Email: `${first.toLowerCase()}@example.org`,
        addressZip: "45127",
        addressCity: "Essen",
      },
      { status: "eingegangen", now },
    );
    ids[first] = r.id;
    return r;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    jana = await loadPermissions(h.db, "u-jana.brandt");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const base = { kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00", capacity: 3 };
    vid = await createVerfahren(h.db, sabine, { ...base, name: "Klasse 5 – 2027/28" });
    other = await createVerfahren(h.db, sabine, { ...base, name: "Seiteneinstieg", kind: "seiteneinstieg" });
    for (const v of [vid, other]) await addSlots(h.db, sabine, v, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
    await publishVerfahren(h.db, sabine, vid, new Date("2027-01-31T10:00:00Z"));
    await publishVerfahren(h.db, sabine, other, new Date("2027-01-31T10:00:00Z"));
    for (const n of ["Anna", "Ben", "Carla", "Dana", "Emil", "Fritz"]) await add(vid, n);
    await add(other, "Gina");
  });
  afterAll(async () => h?.close());

  it("rein: Ergebnis 1…N aufgenommen, Rest Warteliste mit Rang; Nachrechnen", () => {
    expect(lotOutcome(["x", "y", "z"], 1)).toEqual([
      { number: "x", rank: 1, outcome: "aufgenommen", waitlistRank: null },
      { number: "y", rank: 2, outcome: "warteliste", waitlistRank: 1 },
      { number: "z", rank: 3, outcome: "warteliste", waitlistRank: 2 },
    ]);
    const seed = "abc";
    const numbers = ["A-1", "A-2", "A-3"];
    const order = lotOrder(seed, numbers);
    expect(verifyLot({ seed, seedHash: seedHashOf(seed), numbers, order })).toEqual({ hashOk: true, orderOk: true });
    expect(verifyLot({ seed, seedHash: seedHashOf("anders"), numbers, order: [...order].reverse() })).toEqual({ hashOk: false, orderOk: false });
    expect(seedHashOf("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("vorbereiten: nur mit decide, Prüfungen der Gruppe, Seed bleibt geheim, Audit ohne Namen", async () => {
    const group = [ids.Anna!, ids.Ben!, ids.Carla!, ids.Dana!];
    await expect(prepareLot(h.db, sabine, vid, { antragIds: group, places: 2 }, { now })).rejects.toThrow(/anmeldung.decide/);
    await expect(prepareLot(h.db, jana, vid, { antragIds: group, places: 2 }, { now })).rejects.toThrow(/anmeldung.decide/);
    await expect(prepareLot(h.db, petra, vid, { antragIds: [ids.Anna!], places: 1 }, { now })).rejects.toMatchObject({ fieldErrors: { antraege: expect.stringMatching(/zwei/) } });
    await expect(prepareLot(h.db, petra, vid, { antragIds: group, places: 4 }, { now })).rejects.toMatchObject({ fieldErrors: { places: expect.stringMatching(/kein Los nötig/) } });
    await expect(prepareLot(h.db, petra, vid, { antragIds: group, places: "0" }, { now })).rejects.toMatchObject({ fieldErrors: { places: expect.any(String) } });
    await expect(prepareLot(h.db, petra, vid, { antragIds: [...group, ids.Gina!], places: 2 }, { now })).rejects.toMatchObject({ fieldErrors: { antraege: expect.stringMatching(/nicht zu diesem Verfahren/) } });

    const lot = await prepareLot(h.db, petra, vid, { antragIds: [...group].reverse(), places: 2 }, { now });
    expect(lot).toMatchObject({ seq: 1, status: "vorbereitet", places: 2, seed: null, order: null });
    expect(lot.seedHash).toMatch(/^[0-9a-f]{64}$/);
    // Teilnehmende nach Vorgangsnummer, nicht nach Klickreihenfolge
    expect(lot.participants.map((p) => p.number)).toEqual([...lot.participants.map((p) => p.number)].sort());
    const [row] = await h.db.select().from(anmeldungLose).where(eq(anmeldungLose.id, lot.id));
    expect(seedHashOf(row!.seed)).toBe(lot.seedHash);
    expect(JSON.stringify(row!.participants)).not.toMatch(/Anna|Kind/);
    // ein Antrag nur in einem offenen Lauf
    await expect(prepareLot(h.db, petra, vid, { antragIds: [ids.Anna!, ids.Emil!], places: 1 }, { now })).rejects.toMatchObject({ fieldErrors: { antraege: expect.stringMatching(/Lauf 1/) } });
    // lesen: Sekretariat ja (ohne Seed), Lehrkraft nein
    const [listed] = await listLots(h.db, sabine, vid);
    expect(listed).toMatchObject({ id: lot.id, seed: null, order: null });
    await expect(listLots(h.db, jana, vid)).rejects.toThrow(/anmeldung.view/);
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "anmeldung.los.vorbereiten"), eq(auditLog.target, lot.id)));
    expect(a?.meta).toMatchObject({ teilnehmende: 4, plaetze: 2 });
    expect(JSON.stringify(a?.meta)).not.toMatch(/Anna|Kind/);
  });

  it("ziehen deckt den Seed auf, Reihenfolge nachrechenbar; Zeug:innen nur Funktionen; nur einmal", async () => {
    const [lot] = await listLots(h.db, petra, vid);
    await expect(drawLot(h.db, sabine, lot!.id, {}, now)).rejects.toThrow(/anmeldung.decide/);
    const drawn = await drawLot(h.db, petra, lot!.id, { witnesses: "  Stellv. Schulleitung,\n Elternvertretung " }, now);
    expect(drawn.status).toBe("gezogen");
    expect(drawn.witnesses).toBe("Stellv. Schulleitung, Elternvertretung");
    expect(drawn.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(seedHashOf(drawn.seed!)).toBe(lot!.seedHash);
    expect(drawn.order).toEqual(lotOrder(drawn.seed!, lot!.participants.map((p) => p.number)));
    await expect(drawLot(h.db, petra, lot!.id, {}, now)).rejects.toMatchObject({ fieldErrors: { los: expect.stringMatching(/schon gezogen/) } });
    const detail = await getLot(h.db, petra, lot!.id);
    expect(detail?.verify).toEqual({ hashOk: true, orderOk: true });
    expect(detail?.rows.map((r) => r.number)).toEqual(drawn.order);
    expect(detail?.rows[0]).toMatchObject({ child: expect.stringMatching(/^Kind, /), outcome: { rank: 1, outcome: "aufgenommen" } });
  });

  it("neu losen nur mit Begründung; alter Lauf bleibt sichtbar, neuer mit gleicher Gruppe und neuem Seed", async () => {
    const [lot] = await listLots(h.db, petra, vid);
    await expect(repeatLot(h.db, petra, lot!.id, "  ", now)).rejects.toMatchObject({ fieldErrors: { reason: expect.any(String) } });
    await expect(discardLot(h.db, petra, lot!.id, null, now)).rejects.toMatchObject({ fieldErrors: { reason: expect.any(String) } });
    const next = await repeatLot(h.db, petra, lot!.id, "Falsche Gruppe: Antrag A fehlte nicht, Plätze stimmen – Zettel vertauscht", now);
    expect(next).toMatchObject({ seq: 2, status: "vorbereitet", places: 2, replacesId: lot!.id, seed: null });
    expect(next.participants).toEqual(lot!.participants);
    expect(next.seedHash).not.toBe(lot!.seedHash);
    const all = await listLots(h.db, petra, vid);
    expect(all.map((l) => [l.seq, l.status])).toEqual([
      [2, "vorbereitet"],
      [1, "verworfen"],
    ]);
    expect(all[1]).toMatchObject({ reason: expect.stringMatching(/Falsche Gruppe/), seed: expect.any(String), order: expect.any(Array) });
    // vorbereitet (Seed noch geheim) → kein Neulosen, nur verwerfen (ohne Begründung möglich)
    await expect(repeatLot(h.db, petra, next.id, "x", now)).rejects.toMatchObject({ fieldErrors: { los: expect.any(String) } });
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "anmeldung.los.wiederholen"))).length).toBe(1);
  });

  it("übernehmen: Rang 1…N aufgenommen, Rest Warteliste mit Rang, Mail wie bei jeder ersten Entscheidung; Liste und Export zeigen den Rang", async () => {
    const [lot] = await listLots(h.db, petra, vid);
    await expect(applyLot(h.db, petra, lot!.id, { school: "L", now })).rejects.toMatchObject({ fieldErrors: { los: expect.stringMatching(/Erst das Los ziehen/) } });
    const drawn = await drawLot(h.db, petra, lot!.id, {}, now);
    const mailsBefore = (await h.db.select().from(mailOutbox)).length;
    await expect(applyLot(h.db, sabine, lot!.id, { school: "L", now })).rejects.toThrow(/anmeldung.decide/);
    const r = await applyLot(h.db, petra, lot!.id, { school: "Lindenhof", now });
    expect(r).toEqual({ admitted: 2, waitlisted: 2, mails: 4 });
    expect((await h.db.select().from(mailOutbox)).length).toBe(mailsBefore + 4);
    const idOf = new Map(drawn.participants.map((p) => [p.number, p.id]));
    const rows = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.verfahrenId, vid));
    const byId = new Map(rows.map((a) => [a.id, a]));
    const got = drawn.order!.map((n) => byId.get(idOf.get(n)!)!);
    expect(got.map((a) => [a.status, a.waitlistRank])).toEqual([
      ["aufgenommen", null],
      ["aufgenommen", null],
      ["warteliste", 1],
      ["warteliste", 2],
    ]);
    expect(got[0]!.decisionNote).toMatch(/Losverfahren Lauf 2: Rang 1 von 4/);
    const events = await h.db.select().from(anmeldungEreignisse).where(and(eq(anmeldungEreignisse.antragId, got[3]!.id), eq(anmeldungEreignisse.kind, "notiz")));
    expect(events.map((e) => e.text)).toContain("Losverfahren Lauf 2: Rang 4 von 4, Wartelisten-Rang 2");
    await expect(applyLot(h.db, petra, lot!.id, { school: "L", now })).rejects.toMatchObject({ fieldErrors: { los: expect.stringMatching(/schon übernommen/) } });
    await expect(discardLot(h.db, petra, lot!.id, "zu spät", now)).rejects.toMatchObject({ fieldErrors: { los: expect.any(String) } });

    const list = await decisionList(h.db, sabine, vid);
    expect(list.rows.find((x) => x.id === got[2]!.id)?.waitlistRank).toBe(1);
    expect(list.rows.find((x) => x.id === got[0]!.id)?.waitlistRank).toBeNull();
    const csv = await exportSvsCsv(h.db, sabine, vid, { columns: ["nummer", "warteliste_rang"], encoding: "utf8", scope: "entschieden" }, now);
    const text = new TextDecoder().decode(csv.body);
    expect(text).toContain("Wartelisten-Rang");
    expect(text).toContain(`${drawn.order![3]};2`);
    expect(await lotsOfAntrag(h.db, vid, got[3]!.id)).toEqual([
      { seq: 1, status: "verworfen", rank: expect.any(Number), total: 4 },
      { seq: 2, status: "uebernommen", rank: 4, total: 4 },
    ]);

    // Nachrücken: der Rang fällt beim Verlassen der Warteliste weg
    await decide(h.db, petra, vid, [got[2]!.id], "aufgenommen", { school: "L", now });
    const [moved] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, got[2]!.id));
    expect(moved).toMatchObject({ status: "aufgenommen", waitlistRank: null });
  });

  it("ändert sich ein Antrag zwischen Vorbereiten und Ziehen/Übernehmen, passiert nichts; verwerfen ohne Begründung vor dem Ziehen", async () => {
    const lot = await prepareLot(h.db, petra, vid, { antragIds: [ids.Emil!, ids.Fritz!], places: 1 }, { now });
    await setAntragStatus(h.db, null, ids.Fritz!, "zurueckgezogen", { now });
    await expect(drawLot(h.db, petra, lot.id, {}, now)).rejects.toMatchObject({ fieldErrors: { los: expect.stringMatching(/Nicht mehr offen/) } });
    const [still] = await h.db.select().from(anmeldungLose).where(eq(anmeldungLose.id, lot.id));
    expect(still?.status).toBe("vorbereitet");
    const d = await discardLot(h.db, petra, lot.id, null, now);
    expect(d.status).toBe("verworfen");
    const [emil] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Emil!));
    expect(emil?.status).toBe("eingegangen");
  });

  it("schon entschiedene Anträge können nicht gelost werden", async () => {
    const decided = (await decisionList(h.db, petra, vid)).rows.filter((r) => r.status === "aufgenommen").map((r) => r.id);
    await expect(prepareLot(h.db, petra, vid, { antragIds: [...decided, ids.Emil!], places: 1 }, { now })).rejects.toMatchObject({
      fieldErrors: { antraege: expect.stringMatching(/Nur offene Anträge/) },
    });
  });
});
