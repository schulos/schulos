import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { chatMembers, chatRooms } from "@/core/db/schema";
import { getGroupProfile, getPersonProfile, listCounselors, listTeachers, searchGroups, searchPeople } from "./service";

describe("Adressbuch – Sichtbarkeit", () => {
  let h: DbHandle;
  let otherClassStudent: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    const { listUsers } = await import("@/modules/verwaltung/users");
    otherClassStudent = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
  }, 60_000);
  afterAll(() => h.close());

  const perms = (id: string) => loadPermissions(h.db, id);

  it("Lehrkräfte sind für alle findbar – auch per Kürzel und mehreren Wörtern", async () => {
    const lea = await perms("u-lea.schaefer");
    expect((await searchPeople(h.db, lea, "BRA")).map((p) => p.id)).toContain("u-jana.brandt"); // trifft auch „Braun“
    expect((await searchPeople(h.db, lea, "jana bra")).map((p) => p.id)).toEqual(["u-jana.brandt"]);
  });

  it("Schülerin findet Mitschüler:innen, aber niemanden aus fremden Klassen", async () => {
    const lea = await perms("u-lea.schaefer");
    const p = await getPersonProfile(h.db, lea, otherClassStudent);
    expect(p).toBeNull();
    const own = await getGroupProfile(h.db, lea, "g-7b");
    const classmate = own!.members.find((m) => m.role === "schueler" && m.id !== "u-lea.schaefer")!;
    expect(await getPersonProfile(h.db, lea, classmate.id)).not.toBeNull();
  });

  it("Eltern sehen ihr Kind und Lehrkräfte, aber keine anderen Kinder", async () => {
    const { listUsers } = await import("@/modules/verwaltung/users");
    const parent = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!;
    const p = await perms(parent.id);
    expect(await getPersonProfile(h.db, p, "u-lea.schaefer")).not.toBeNull();
    expect(await getPersonProfile(h.db, p, otherClassStudent)).toBeNull();
    expect(await getPersonProfile(h.db, p, "u-jana.brandt")).not.toBeNull();
  });

  it("Personal (Hausmeister) sieht Lehrkräfte, Verwaltung und Personal – keine Schüler:innen, keine Eltern (P4-10)", async () => {
    const klaus = await perms("u-klaus.berger");
    expect(klaus.role).toBe("personal");
    expect((await searchPeople(h.db, klaus, "jana bra")).map((p) => p.id)).toEqual(["u-jana.brandt"]);
    expect((await searchPeople(h.db, klaus, "kowalski")).map((p) => p.id)).toContain("u-sabine.kowalski");
    expect(await getPersonProfile(h.db, klaus, "u-lea.schaefer")).toBeNull();
    expect(await getPersonProfile(h.db, klaus, otherClassStudent)).toBeNull();
    expect(await searchPeople(h.db, klaus, "schäfer")).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: "u-lea.schaefer" })]));
    const hits = await searchPeople(h.db, klaus, "a", 500);
    expect(hits.every((p) => ["lehrkraft", "verwaltung", "personal", "beratung"].includes(p.role) || p.id === klaus.userId)).toBe(true);
    // fremde Gruppen (Klassen) bleiben zu, die eigene Gruppe ist sichtbar
    expect(await getGroupProfile(h.db, klaus, "g-7b")).toBeNull();
    expect(await getGroupProfile(h.db, klaus, "g-hausmeisterei")).not.toBeNull();
    // Schüler:innen sehen das Personal nicht
    const lea = await perms("u-lea.schaefer");
    expect(await getPersonProfile(h.db, lea, "u-klaus.berger")).toBeNull();
    // Lehrkräfte schon
    expect(await getPersonProfile(h.db, await perms("u-jana.brandt"), "u-klaus.berger")).not.toBeNull();
  });

  it("Beratung (Q5-17): für Schüler:innen und Eltern sichtbar mit Sprechzeiten; sieht selbst nur Erwachsene, eigene Gruppen und Chat-Gegenüber", async () => {
    const NINA = "u-nina.ostermann";
    const lea = await perms("u-lea.schaefer");
    const profile = await getPersonProfile(h.db, lea, NINA);
    expect(profile?.person).toMatchObject({ role: "beratung", officeHours: expect.stringContaining("Raum") });
    expect((await listCounselors(h.db)).map((c) => c.id)).toEqual([NINA]);
    const { listUsers } = await import("@/modules/verwaltung/users");
    const parent = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!;
    expect(await getPersonProfile(h.db, await perms(parent.id), NINA)).not.toBeNull();
    expect(await getPersonProfile(h.db, await perms("u-klaus.berger"), NINA)).not.toBeNull();

    const nina = await perms(NINA);
    expect(nina.role).toBe("beratung");
    expect(await getPersonProfile(h.db, nina, "u-jana.brandt")).not.toBeNull();
    expect(await getPersonProfile(h.db, nina, "u-lea.schaefer")).toBeNull();
    expect(await getPersonProfile(h.db, nina, parent.id)).toBeNull();
    expect(await getGroupProfile(h.db, nina, "g-7b")).toBeNull();
    const hits = await searchPeople(h.db, nina, "a", 500);
    expect(hits.every((p) => ["lehrkraft", "verwaltung", "personal", "beratung"].includes(p.role))).toBe(true);

    // besteht ein Direktchat (von Lea begonnen), sieht die Beratung Lea – sonst niemanden aus der 7b
    const [room] = await h.db.insert(chatRooms).values({ kind: "direct", directKey: [NINA, "u-lea.schaefer"].sort().join("|") }).returning();
    await h.db.insert(chatMembers).values([
      { roomId: room!.id, userId: NINA },
      { roomId: room!.id, userId: "u-lea.schaefer" },
    ]);
    expect(await getPersonProfile(h.db, nina, "u-lea.schaefer")).not.toBeNull();
    expect(await getPersonProfile(h.db, nina, otherClassStudent)).toBeNull();
  });

  it("Lehrkraft sieht alle Personen und alle Gruppen", async () => {
    const lk = await perms("u-jana.brandt");
    expect(await getPersonProfile(h.db, lk, otherClassStudent)).not.toBeNull();
    expect((await searchGroups(h.db, lk, "9a")).map((g) => g.id)).toContain("g-9a");
  });

  it("Gruppen nur für Mitglieder; Profil zeigt fremden Schüler:innen nur gemeinsame Gruppen", async () => {
    const lea = await perms("u-lea.schaefer");
    expect(await getGroupProfile(h.db, lea, "g-9a")).toBeNull();
    expect((await searchGroups(h.db, lea, "a")).every((g) => lea.memberOf.has(g.id))).toBe(true);
    const brandt = await getPersonProfile(h.db, lea, "u-jana.brandt");
    expect(brandt?.groupsAreShared).toBe(true);
    expect(brandt?.groups.every((g) => lea.memberOf.has(g.id))).toBe(true);
    expect(brandt?.subjects.map((s) => s.name)).toEqual(["Deutsch", "Englisch"]);
    expect(brandt?.classLeads).toEqual(["Klasse 7b"]);
  });

  it("listTeachers liefert Fächer", async () => {
    const t = await listTeachers(h.db);
    expect(t).toHaveLength(28);
    expect(t.find((x) => x.shortCode === "KLE")?.subjects.map((s) => s.name)).toEqual(["Mathematik", "Physik"]);
  });

  it("leere Suche liefert nichts, Sonderzeichen sind harmlos", async () => {
    const lea = await perms("u-lea.schaefer");
    expect(await searchPeople(h.db, lea, "   ")).toEqual([]);
    expect(await searchPeople(h.db, lea, "%_%")).toEqual([]);
  });
});
