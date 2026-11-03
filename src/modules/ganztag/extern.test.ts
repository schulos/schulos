// GT-13: externe Leitungen – befristetes Konto der Rolle `personal`, nur Leitung des eigenen Angebots, 2FA Pflicht, Hinweis vor
// Ablauf, danach gesperrt (Abgang); Verlängern öffnet wieder. Feste Daten (`now` wird übergeben).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { ganztagExternalLeaders, groupMembers, notifications, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions, twoFactorDuty } from "@/core/permissions";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import { createExternalLeader, defaultExpiry, endExternal, extendExternal, listExternalLeaders, runExternalExpiry } from "./extern";
import { getOffer, listOffers, setListFeature } from "./service";

const SEKRETARIAT = "u-sabine.kowalski";
const LEHRKRAFT = "u-jana.brandt";
const CHOR = "g-ag-schulchor";
const NOW = new Date("2026-11-10T10:00:00Z");

describe("Ganztag GT-13 externe Leitungen (DB)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let ext = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await setListFeature(h.db, await p(SEKRETARIAT), CHOR, true);
  }, 60_000);
  afterAll(async () => h?.close());

  const input = (over: Partial<Parameters<typeof createExternalLeader>[2]> = {}) => ({
    firstName: "Extern",
    lastName: "Chorleitung",
    provider: "Musikverein am Ort",
    groupId: CHOR,
    expiresOn: "2026-12-01",
    confidentiality: true,
    ...over,
  });

  it("nur mit „Ganztag verwalten“ und „Benutzer verwalten“; Pflichtangaben und Befristung höchstens ein Jahr", async () => {
    await expect(createExternalLeader(h.db, await p(LEHRKRAFT), input(), NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createExternalLeader(h.db, await p(SEKRETARIAT), input({ confidentiality: false }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createExternalLeader(h.db, await p(SEKRETARIAT), input({ provider: " " }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createExternalLeader(h.db, await p(SEKRETARIAT), input({ expiresOn: "2028-01-01" }), NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(createExternalLeader(h.db, await p(SEKRETARIAT), input({ groupId: "g-7b" }), NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(await defaultExpiry(h.db, CHOR, "2026-11-10")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("legt ein befristetes Personal-Konto als Leitung genau dieses Angebots an; 2FA ist Pflicht", async () => {
    const r = await createExternalLeader(h.db, await p(SEKRETARIAT), input(), NOW);
    ext = r.userId;
    expect(r.password.length).toBeGreaterThan(8);
    const [u] = await h.db.select({ role: users.role, expiresOn: users.expiresOn, status: users.status }).from(users).where(eq(users.id, ext));
    expect(u).toEqual({ role: "personal", expiresOn: "2026-12-01", status: "active" });
    const memberships = await h.db.select({ groupId: groupMembers.groupId, role: groupMembers.role }).from(groupMembers).where(eq(groupMembers.userId, ext));
    expect(memberships).toEqual([{ groupId: CHOR, role: "leader" }]);
    // befristete Konten: 2FA sofort Pflicht (unabhängig vom Stichtag der Schule)
    expect(twoFactorDuty("personal", [], null, "2026-11-10", { temporary: true }).required).toBe(true);
    expect(twoFactorDuty("personal", [], null, "2026-11-10").required).toBe(false);
    // nach Startpasswort und 2FA: nur das eigene Angebot
    await h.db.update(users).set({ mustChangePassword: false, twoFactorEnabled: true }).where(eq(users.id, ext));
    const perms = await p(ext);
    expect([...perms.leaderOf]).toEqual([CHOR]);
    expect((await listOffers(h.db, perms, NOW)).map((o) => o.id)).toEqual([CHOR]);
    expect(await getOffer(h.db, perms, "g-ag-robotik", NOW)).toBeNull();
    const list = await listExternalLeaders(h.db, await p(SEKRETARIAT), NOW);
    expect(list).toEqual([expect.objectContaining({ userId: ext, provider: "Musikverein am Ort", state: "aktiv", expiresOn: "2026-12-01" })]);
  });

  it("Hinweis 14 Tage vor Ablauf (einmal), danach gesperrt; Verlängern öffnet wieder", async () => {
    expect(await runExternalExpiry(h.db, NOW)).toEqual({ warned: 0, locked: 0 });
    const warnAt = new Date("2026-11-18T07:00:00Z");
    expect(await runExternalExpiry(h.db, warnAt)).toEqual({ warned: 1, locked: 0 });
    expect(await runExternalExpiry(h.db, warnAt)).toEqual({ warned: 0, locked: 0 });
    const toPerson = await h.db.select({ title: notifications.title }).from(notifications).where(eq(notifications.userId, ext));
    expect(toPerson.map((n) => n.title)).toContain("Dein Zugang endet am 01.12.2026");
    const toOffice = await h.db.select({ body: notifications.body }).from(notifications).where(and(eq(notifications.userId, SEKRETARIAT), eq(notifications.title, "Externe Leitung: Zugang endet am 01.12.2026")));
    expect(toOffice).toHaveLength(1);
    // am Ablauftag noch aktiv, am Tag danach gesperrt (auch ohne Job sofort ohne Rechte)
    expect((await loadPermissions(h.db, ext, new Date("2026-12-01T20:00:00Z"))).locked).toBe(false);
    expect((await loadPermissions(h.db, ext, new Date("2026-12-02T07:00:00Z"))).locked).toBe(true);
    expect(await runExternalExpiry(h.db, new Date("2026-12-02T07:00:00Z"))).toEqual({ warned: 0, locked: 1 });
    const [u] = await h.db.select({ status: users.status, leftOn: users.leftOn }).from(users).where(eq(users.id, ext));
    expect(u).toEqual({ status: "locked", leftOn: "2026-12-01" });
    expect((await listExternalLeaders(h.db, await p(SEKRETARIAT), new Date("2026-12-02T07:00:00Z")))[0]!.state).toBe("abgelaufen");
    await extendExternal(h.db, await p(SEKRETARIAT), ext, "2027-03-31", new Date("2026-12-02T07:00:00Z"));
    const [again] = await h.db.select({ status: users.status, leftOn: users.leftOn, expiresOn: users.expiresOn }).from(users).where(eq(users.id, ext));
    expect(again).toEqual({ status: "active", leftOn: null, expiresOn: "2027-03-31" });
    expect((await loadPermissions(h.db, ext, new Date("2026-12-02T07:00:00Z"))).locked).toBe(false);
  });

  it("Zugang sofort beenden; Zuordnung geht mit dem Konto", async () => {
    await endExternal(h.db, await p(SEKRETARIAT), ext, NOW);
    const [u] = await h.db.select({ status: users.status }).from(users).where(eq(users.id, ext));
    expect(u?.status).toBe("locked");
    await deleteAccounts(h.db, [ext]);
    expect(await h.db.select().from(ganztagExternalLeaders).where(eq(ganztagExternalLeaders.userId, ext))).toHaveLength(0);
  });
});
