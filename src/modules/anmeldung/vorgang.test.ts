import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, mailOutbox, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions, type PermissionSet } from "@/core/permissions";
import { submitAccountAntrag } from "./konto";
import { changeVorgangSlot, confirmAntrag, formStamp, loadVorgang, purgeUnconfirmed, submitAntrag, withdrawVorgang } from "./public";
import { addSlots, createVerfahren, listSlots, publishVerfahren, setAntragStatus } from "./service";

const now = new Date("2027-02-05T10:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const H = 3_600_000;

describe("Vorgang für Eltern (P4-35): Termin ändern, zurückziehen, 48-h-Löschjob", () => {
  let h: DbHandle;
  let sabine: PermissionSet;
  let petra: PermissionSet;
  let mutter: PermissionSet;
  let vid: string;
  let slots: string[];
  let n = 0;

  const ctx = (t = now) => ({ ip: `10.1.0.${++n % 250}`, now: t, school: "Lindenhof", state: "NW" as const });
  const lastMail = async (to: string) => (await h.db.select().from(mailOutbox).where(eq(mailOutbox.to, to)).orderBy(desc(mailOutbox.createdAt), desc(mailOutbox.id)))[0];
  const tokenFrom = (text: string, path: string) => new RegExp(`${path}([A-Za-z0-9_-]{43})`).exec(text)?.[1];
  const form = (email: string, slotId: string, t = now): Record<string, string> => ({
    childFirstName: "Mia",
    childLastName: "Muster",
    childBirthDate: "2016-05-01",
    primarySchool: "GS Am Park",
    parent1Name: "Eva Muster",
    parent1Email: email,
    addressStreet: "Weg 1",
    addressZip: "12345",
    addressCity: "Stadt",
    consent: "on",
    slotId,
    stamp: formStamp(vid, new Date(t.getTime() - 10_000)),
  });

  /** Antrag einreichen und bestätigen → Vorgangs-Token */
  const confirmed = async (email: string, slotId: string): Promise<string> => {
    expect(await submitAntrag(h.db, vid, form(email, slotId), ctx())).toEqual({ ok: true });
    const t = tokenFrom((await lastMail(email))!.text, "/anmeldung/bestaetigen/")!;
    const r = await confirmAntrag(h.db, t, ctx(at(60_000)));
    if (r.state !== "ok") throw new Error("nicht bestätigt");
    return r.value.accessToken;
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    sabine = await loadPermissions(h.db, "u-sabine.kowalski");
    petra = await loadPermissions(h.db, "u-petra.lindner");
    mutter = await loadPermissions(h.db, "u-daniela.schaefer");
    await h.db.insert(schoolYears).values({ id: "sj-2027-28", name: "2027/28", startsOn: "2027-08-01", endsOn: "2028-07-31" });
    vid = await createVerfahren(h.db, sabine, { name: "Klasse 5", kind: "klasse5", targetSchoolYearId: "sj-2027-28", targetGradeLevel: 5, opensAt: "2027-02-01T08:00", closesAt: "2027-02-28T18:00" });
    await addSlots(h.db, sabine, vid, { days: ["2027-02-10"], windows: [{ from: "14:00", to: "16:00" }], durationMinutes: 30, parallel: 1 });
    await publishVerfahren(h.db, sabine, vid, at(-H));
    slots = (await listSlots(h.db, vid, now)).map((s) => s.id);
  });
  afterAll(async () => h?.close());

  it("Termin ändern: nur freie künftige Termine, Mail an die Eltern, Verlauf; alter Termin wird frei", async () => {
    const token = await confirmed("a@example.org", slots[0]!);
    // belegter Termin
    await confirmed("b@example.org", slots[1]!);
    expect(await changeVorgangSlot(h.db, { token }, slots[1]!, ctx(at(H)))).toMatchObject({ ok: false, error: /ausgebucht/ });
    expect(await changeVorgangSlot(h.db, { token }, "gibts-nicht", ctx(at(H)))).toMatchObject({ ok: false });
    expect(await changeVorgangSlot(h.db, { token }, slots[2]!, ctx(at(H)))).toMatchObject({ ok: true });
    const v = await loadVorgang(h.db, token, ctx(at(H)));
    expect(v.state === "ok" && v.value.slot?.id).toBe(slots[2]);
    expect((await lastMail("a@example.org"))).toMatchObject({ purpose: "anmeldung-termin" });
    expect((await listSlots(h.db, vid, at(H)))[0]).toMatchObject({ booked: 0 });
    // nach dem Termin geht kein Termin in der Vergangenheit
    expect(await changeVorgangSlot(h.db, { token }, slots[3]!, ctx(new Date("2027-02-10T16:00:00Z")))).toMatchObject({ ok: false, error: /Vergangenheit/ });
    // falscher Token
    expect(await changeVorgangSlot(h.db, { token: "x".repeat(43) }, slots[3]!, ctx())).toMatchObject({ ok: false, error: /ungültig/ });
  });

  it("Zurückziehen: Termin frei, Löschfrist beginnt, Mail; danach keine Änderungen mehr; Entschiedenes nicht", async () => {
    const token = await confirmed("c@example.org", slots[3]!);
    expect(await withdrawVorgang(h.db, { token }, ctx(at(2 * H)))).toMatchObject({ ok: true });
    const [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.parent1Email, "c@example.org"));
    expect(a).toMatchObject({ status: "zurueckgezogen", retentionFrom: at(2 * H) });
    expect((await lastMail("c@example.org"))).toMatchObject({ purpose: "anmeldung-zurueckgezogen" });
    expect((await listSlots(h.db, vid, at(2 * H)))[3]).toMatchObject({ booked: 0 });
    expect(await changeVorgangSlot(h.db, { token }, slots[3]!, ctx(at(3 * H)))).toMatchObject({ ok: false, error: /entschieden/ });
    const v = await loadVorgang(h.db, token, ctx(at(3 * H)));
    expect(v).toMatchObject({ state: "ok", value: { status: "zurueckgezogen", open: false } });

    const t2 = await confirmed("d@example.org", slots[3]!);
    const [d] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.parent1Email, "d@example.org"));
    await setAntragStatus(h.db, petra, d!.id, "aufgenommen", { now: at(3 * H) });
    expect(await withdrawVorgang(h.db, { token: t2 }, ctx(at(4 * H)))).toMatchObject({ ok: false, error: /entschieden/ });
  });

  it("Elternkonto: nur eigene Anträge ändern bzw. zurückziehen", async () => {
    const r = await submitAccountAntrag(h.db, mutter, vid, { ...form("mutter@example.org", slots[2]!), childFirstName: "Jan" }, { now, school: "L" });
    expect(r.ok).toBe(false); // Termin 3 ist belegt (Platz 1)
    const ok = await submitAccountAntrag(h.db, mutter, vid, { ...form("mutter@example.org", slots[0]!), childFirstName: "Jan" }, { now, school: "L" });
    expect(ok.ok).toBe(true);
    const other = await loadPermissions(h.db, "u-jana.brandt");
    expect(await withdrawVorgang(h.db, { antragId: ok.antragId!, viewer: other }, ctx())).toMatchObject({ ok: false, error: /ungültig/ });
    expect(await withdrawVorgang(h.db, { antragId: ok.antragId!, viewer: mutter }, ctx())).toMatchObject({ ok: true });
  });

  it("Löschjob: unbestätigte Anträge nach 48 h vollständig weg (mit Verlauf), bestätigte bleiben", async () => {
    expect(await submitAntrag(h.db, vid, form("weg@example.org", slots[0]!), ctx())).toEqual({ ok: true });
    const [a] = await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.parent1Email, "weg@example.org"));
    expect(await purgeUnconfirmed(h.db, at(47 * H))).toBe(0);
    expect(await purgeUnconfirmed(h.db, at(48 * H + 1))).toBe(1);
    expect(await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.id, a!.id))).toHaveLength(0);
    expect(await h.db.select().from(anmeldungEreignisse).where(eq(anmeldungEreignisse.antragId, a!.id))).toHaveLength(0);
    expect((await h.db.select().from(anmeldungAntraege).where(eq(anmeldungAntraege.parent1Email, "a@example.org"))).length).toBe(1);
  });
});
