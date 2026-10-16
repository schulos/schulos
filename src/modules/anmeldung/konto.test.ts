import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, mailOutbox, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { accountPrefill, myAntraege, myAntrag, submitAccountAntrag } from "./konto";
import { validateAntragForm } from "./public";
import { addSlots, createVerfahren, listSlots, publishVerfahren } from "./service";

const now = new Date("2027-02-05T10:00:00Z");

describe("Schulanmeldung mit Elternkonto (P4-34b)", () => {
  let h: DbHandle;
  let mutter: PermissionSet;
  let anderer: PermissionSet;
  let jana: PermissionSet;
  let vid: string;
  let slot: string;

  const raw = (extra: Record<string, string> = {}): Record<string, string> => ({
    childFirstName: "Ben",
    childLastName: "Schäfer",
    childBirthDate: "2016-04-02",
    primarySchool: "GS Am Park",
    parent1Name: "Daniela Schäfer",
    parent1Email: "daniela@example.org",
    addressStreet: "Lindenweg 5",
    addressZip: "12345",
    addressCity: "Musterstadt",
    consent: "on",
    slotId: slot,
    ...extra,
  });

  beforeAll(async () => {
    h = await createSeededTestDb();
    mutter = await loadPermissions(h.db, "u-daniela.schaefer");
    const [other] = await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern")).limit(5);
    const otherId = (await h.db.select({ id: users.id }).from(users).where(eq(users.role, "eltern"))).find((u) => u.id !== mutter.userId)!.id;
    expect(other).toBeTruthy();
    anderer = await loadPermissions(h.db, otherId);
    jana = await loadPermissions(h.db, "u-jana.brandt");
    const sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, { name: "Klasse 5 – 2027/28", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "15:00" }], durationMinutes: 30, parallel: 3 });
    await publishVerfahren(h.db, sabine, vid, new Date("2027-01-31T10:00:00Z"));
    slot = (await listSlots(h.db, vid, now))[0]!.id;
  });
  afterAll(async () => h?.close());

  it("Vorbelegung aus dem Konto: Name, Geschwisterkind mit Klasse; Platzhalter-Adresse wird nicht übernommen", async () => {
    expect(mutter.role).toBe("eltern");
    const p = await accountPrefill(h.db, mutter);
    expect(p.parent1Name).toBe("Daniela Schäfer");
    expect(p.parent1Email).toBe(""); // Demo-Konten haben nur Platzhalter
    expect(p.sibling).toBe("on");
    expect(p.siblingNote).toMatch(/Lea Schäfer, Klasse 7b/);
    // die Vorbelegung besteht selbst die Prüfung
    expect(() => validateAntragForm({ ...raw(), ...p, parent1Email: "x@example.org" }, { kind: "klasse5", fields: { geschwister: true, zweitwunsch: true, elternteil2: true, hinweise: true }, targetGradeLevel: 5, schoolYearStartsOn: "2027-08-01" }, "2027-02-05")).not.toThrow();
    await expect(accountPrefill(h.db, jana)).rejects.toThrow(/Elternkonten/);
  });

  it("Antrag ohne Mailbestätigung: gleich mit Termin, am Konto, ohne Links; nur Eltern", async () => {
    const r = await submitAccountAntrag(h.db, mutter, vid, raw(), { now, school: "Lindenhof" });
    expect(r).toMatchObject({ ok: true, antragId: expect.any(String) });
    const [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, r.antragId!));
    expect(a).toMatchObject({ status: "termin", parentUserId: mutter.userId, confirmedAt: now, confirmTokenHash: null, accessTokenHash: null, retentionFrom: null });
    const [mail] = await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, "daniela@example.org"));
    expect(mail!.text).toContain("/schulanmeldung");
    expect(mail!.text).not.toContain("Ben");
    await expect(submitAccountAntrag(h.db, jana, vid, raw(), { now, school: "Lindenhof" })).rejects.toThrow(/Elternkonten/);
    expect(await submitAccountAntrag(h.db, mutter, vid, raw({ childBirthDate: "2022-01-01" }), { now, school: "Lindenhof" })).toMatchObject({ ok: false, fieldErrors: { childBirthDate: expect.any(String) } });
  });

  it("eigene Anträge sichtbar, fremde nicht (auch nicht per ID)", async () => {
    const mine = await myAntraege(h.db, mutter);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ childFirstName: "Ben", status: "termin", verfahren: "Klasse 5 – 2027/28" });
    expect(await myAntrag(h.db, mutter, mine[0]!.id)).toMatchObject({ status: "termin", open: true });
    expect(await myAntrag(h.db, anderer, mine[0]!.id)).toBeNull();
    expect(await myAntrag(h.db, jana, mine[0]!.id)).toBeNull();
    expect(await myAntraege(h.db, anderer)).toEqual([]);
  });

  it("Grenzen: höchstens 4 offene je Konto und Verfahren, 5 je Tag", async () => {
    const [s0, s1] = (await listSlots(h.db, vid, now)).map((s) => s.id);
    for (let i = 0; i < 3; i++) expect((await submitAccountAntrag(h.db, mutter, vid, raw({ childFirstName: `Kind ${"abc"[i]}`, slotId: i < 2 ? s0! : s1! }), { now, school: "L" })).ok).toBe(true);
    expect(await submitAccountAntrag(h.db, mutter, vid, raw({ slotId: s1! }), { now, school: "L" })).toMatchObject({ ok: false, error: /schon 4/ });
    expect((await myAntraege(h.db, mutter)).length).toBeLessThanOrEqual(4);
  });
});
