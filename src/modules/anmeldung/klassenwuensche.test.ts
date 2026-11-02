import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungKlassenwuensche, auditLog, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { antragAuskunft } from "./auskunft";
import { decide } from "./entscheidung";
import { proposeClasses } from "./klassenbildung";
import { addKlassenwunsch, klassenwunschView, removeKlassenwunsch, setFamilySeparate, wishesForAdmission } from "./klassenwuensche";
import { addSlots, createVerfahren, insertAntrag, publishVerfahren } from "./service";
import { pendingAdmissions } from "./uebernahme";

describe("Klassenwünsche (KB-03)", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  let other: string;
  const ids: Record<string, string> = {};
  const now = new Date("2027-03-01T10:00:00Z");

  const add = async (verfahrenId: string, first: string, last: string, email: string, status: "eingegangen" | "unbestaetigt" = "eingegangen") => {
    const r = await insertAntrag(
      h.db,
      verfahrenId,
      {
        childFirstName: first,
        childLastName: last,
        childBirthDate: "2016-04-03",
        primarySchool: "GS Nord",
        parent1Name: `Andrea ${last}`,
        parent1Email: email,
        addressStreet: "Weg 1",
        addressZip: "45127",
        addressCity: "Essen",
      },
      { status, now: new Date("2027-02-05T10:00:00Z"), parentUserId: null },
    );
    ids[first] = r.id;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    jana = await loadPermissions(h.db, "u-jana.brandt");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    const mk = async (name: string) => {
      const id = await createVerfahren(h.db, sabine, { name, kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
      await addSlots(h.db, sabine, id, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 2 });
      await publishVerfahren(h.db, sabine, id, new Date("2027-01-31T10:00:00Z"));
      return id;
    };
    vid = await mk("Klasse 5");
    other = await mk("Klasse 5 – zweites Verfahren");
    await add(vid, "Anna", "Adler", "adler@example.org");
    await add(vid, "Ben", "Berg", "berg@example.org");
    await add(vid, "Cem", "Celik", "celik@example.org");
    await add(vid, "Dana", "Dorn", "dorn@example.org");
    await add(vid, "Max", "Zwilling", "zwilling@example.org");
    await add(vid, "Moritz", "Zwilling", " ZWILLING@example.org");
    await add(vid, "Udo", "Unbestaetigt", "udo@example.org", "unbestaetigt");
    await add(other, "Fremd", "Verfahren", "fremd@example.org");
  });
  afterAll(async () => h?.close());

  it("erfassen: nur mit anmeldung.manage, Partner aus demselben Verfahren, keine Selbstwünsche, je Paar eine Art, höchstens 2", async () => {
    await expect(addKlassenwunsch(h.db, petra, ids.Anna!, { partnerId: ids.Ben!, art: "zusammen" })).rejects.toThrow(/anmeldung.manage/);
    await expect(addKlassenwunsch(h.db, jana, ids.Anna!, { partnerId: ids.Ben!, art: "zusammen" })).rejects.toThrow(/anmeldung.manage/);
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Anna!, art: "zusammen" })).rejects.toMatchObject({ fieldErrors: { partnerId: /selbst/ } });
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Fremd!, art: "zusammen" })).rejects.toMatchObject({ fieldErrors: { partnerId: /Verfahren/ } });
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Udo!, art: "zusammen" })).rejects.toMatchObject({ fieldErrors: { partnerId: /Verfahren/ } });
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Ben!, art: "Freundin" })).rejects.toMatchObject({ fieldErrors: { art: expect.any(String) } });
    await addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Ben!, art: "zusammen" }, now);
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Ben!, art: "nicht_zusammen" })).rejects.toMatchObject({ fieldErrors: { partnerId: /schon/ } });
    await addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Cem!, art: "nicht_zusammen" }, new Date(now.getTime() + 1000));
    await expect(addKlassenwunsch(h.db, sabine, ids.Anna!, { partnerId: ids.Dana!, art: "zusammen" })).rejects.toMatchObject({ fieldErrors: { partnerId: /Höchstens 2/ } });
    // gegenseitig
    await addKlassenwunsch(h.db, sabine, ids.Ben!, { partnerId: ids.Anna!, art: "zusammen" }, now);
    const log = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "anmeldung.antrag.wunsch"), eq(auditLog.target, ids.Anna!)));
    expect(log).toHaveLength(2);
    // Audit ohne Partner
    expect(JSON.stringify(log)).not.toContain(ids.Ben!);
  });

  it("Ansicht: eigene Wünsche, Nennungen anderer, Kandidaten ohne gewählte/unbestätigte/fremde; Lesen mit anmeldung.view", async () => {
    const v = (await klassenwunschView(h.db, petra, ids.Anna!))!;
    expect(v.editable).toBe(false); // Schulleitung liest nur
    expect(v.own.map((w) => [w.art, w.partner.name])).toEqual([
      ["zusammen", "Berg, Ben"],
      ["nicht_zusammen", "Celik, Cem"],
    ]);
    expect(v.incoming.map((w) => w.partner.name)).toEqual(["Berg, Ben"]);
    const names = v.candidates.map((c) => c.name);
    expect(names).toContain("Dorn, Dana");
    expect(names).not.toContain("Berg, Ben");
    expect(names).not.toContain("Unbestaetigt, Udo");
    expect(names).not.toContain("Verfahren, Fremd");
    expect(v.family).toEqual([]);
    expect((await klassenwunschView(h.db, sabine, ids.Anna!))!.editable).toBe(true);
    await expect(klassenwunschView(h.db, jana, ids.Anna!)).rejects.toThrow(/anmeldung.view/);
  });

  it("entfernen: nur eigener Wunsch des Antrags", async () => {
    const v = (await klassenwunschView(h.db, sabine, ids.Anna!))!;
    const cem = v.own.find((w) => w.partner.name === "Celik, Cem")!;
    await expect(removeKlassenwunsch(h.db, sabine, ids.Ben!, cem.id)).rejects.toMatchObject({ fieldErrors: { wish: expect.any(String) } });
    await expect(removeKlassenwunsch(h.db, petra, ids.Anna!, cem.id)).rejects.toThrow(/anmeldung.manage/);
    await removeKlassenwunsch(h.db, sabine, ids.Anna!, cem.id);
    expect((await klassenwunschView(h.db, sabine, ids.Anna!))!.own).toHaveLength(1);
  });

  it("„getrennt“ gilt für die ganze Familie (gleiche E-Mail, ohne Groß/Klein), Vorgabe zusammen", async () => {
    const v = (await klassenwunschView(h.db, sabine, ids.Max!))!;
    expect(v.family.map((f) => f.name)).toEqual(["Zwilling, Moritz"]);
    expect(v.familySeparate).toBe(false);
    await expect(setFamilySeparate(h.db, petra, ids.Max!, true)).rejects.toThrow(/anmeldung.manage/);
    expect(await setFamilySeparate(h.db, sabine, ids.Max!, true)).toBe(2);
    expect((await klassenwunschView(h.db, sabine, ids.Moritz!))!.familySeparate).toBe(true);
    expect(await setFamilySeparate(h.db, sabine, ids.Moritz!, true)).toBe(0);
    const anna = await h.db.select({ s: anmeldungAntraege.familySeparate }).from(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Anna!));
    expect(anna[0]!.s).toBe(false);
  });

  it("Neuaufnahmen: Wünsche nur zwischen Kandidaten, „getrennt“ am Kandidaten; der Vorschlag beachtet beides", async () => {
    await decide(h.db, petra, vid, ["Anna", "Ben", "Cem", "Dana", "Max", "Moritz"].map((n) => ids[n]!), "aufgenommen", { school: "L", now });
    const cands = await pendingAdmissions(h.db, "sj-2027-28");
    expect(cands.filter((c) => c.familySeparate).map((c) => c.childFirstName).sort()).toEqual(["Max", "Moritz"]);
    const wishes = await wishesForAdmission(h.db, cands.map((c) => c.antragId));
    expect(wishes).toEqual(
      expect.arrayContaining([
        { from: ids.Anna, to: ids.Ben, kind: "zusammen" },
        { from: ids.Ben, to: ids.Anna, kind: "zusammen" },
      ]),
    );
    expect(wishes).toHaveLength(2);
    // ohne Ben unter den Kandidaten fällt der Wunsch weg
    expect(await wishesForAdmission(h.db, [ids.Anna!, ids.Cem!])).toEqual([]);
    const res = proposeClasses({
      children: cands.map((c) => ({ id: c.antragId, label: c.childFirstName, school: c.primarySchool, family: c.parent1Email })),
      classNames: ["5a", "5b"],
      wishes,
      separateFamilies: [...new Set(cands.filter((c) => c.familySeparate).map((c) => c.parent1Email))],
    });
    expect(res.assignment[ids.Anna!]).toBe(res.assignment[ids.Ben!]);
    expect(res.assignment[ids.Max!]).not.toBe(res.assignment[ids.Moritz!]);
  });

  it("Auskunft: eigene Wünsche ohne Partnerkind; Löschung folgt dem Antrag (Cascade auf beide Seiten)", async () => {
    const r = (await antragAuskunft(h.db, sabine, ids.Anna!, { now }))!;
    const kb = (r.data.antrag as Record<string, unknown>).klassenbildung as { wuensche: { wunsch: string }[]; familieGetrennt: boolean };
    expect(kb.wuensche.map((w) => w.wunsch)).toEqual(["Wunsch zusammen mit einem anderen Kind"]);
    expect(kb.familieGetrennt).toBe(false);
    const json = JSON.stringify(r.data);
    expect(json).not.toContain("Berg");
    expect(json).not.toContain(ids.Ben!);
    await h.db.delete(anmeldungAntraege).where(eq(anmeldungAntraege.id, ids.Ben!));
    expect(await h.db.select().from(anmeldungKlassenwuensche)).toEqual([]);
  });
});
