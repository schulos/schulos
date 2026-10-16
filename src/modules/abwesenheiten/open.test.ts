import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { grants, groupMembers, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { OPEN_CALENDAR } from "@/core/school/calendar";
import { listUsers } from "@/modules/verwaltung/users";
import { requestLeave } from "./beurlaubung";
import { abwesenheitenOpen } from "./open";

const TODAY = "2026-10-09";
const NOW = new Date("2026-10-09T08:00:00Z");
const lea = "u-lea.schaefer";
const jana = "u-jana.brandt";

describe("„Offen für dich“ Abwesenheiten (GATE-4f C-06, C-10, S-02)", () => {
  let h: DbHandle;
  let mutter: string;
  const items = async (userId: string) => abwesenheitenOpen.collect(h.db, { perms: await loadPermissions(h.db, userId) } as CurrentUser, NOW);

  beforeAll(async () => {
    h = await createSeededTestDb();
    mutter = (await listUsers(h.db, { q: "Daniela Schäfer" })).rows[0]!.id;
    const req = async (fromDate: string, toDate: string) =>
      requestLeave(h.db, await loadPermissions(h.db, mutter), { studentId: lea, fromDate, toDate, reason: "familiaer" }, TODAY, OPEN_CALENDAR);
    await req("2026-10-12", "2026-10-12"); // Klassenleitung
    await req("2026-11-02", "2026-11-04"); // Schulleitung (3 Schultage)
  }, 60_000);
  afterAll(() => h.close());

  it("C-06: Schulleitung, die zugleich Klassenleitung ist, sieht die Anträge beider Stufen", async () => {
    const before = (await items(jana)).find((i) => i.id === "abwesenheiten:beurlaubung");
    expect(before?.count).toBe(1); // nur Klassenleitung
    await h.db.insert(groupMembers).values({ groupId: "g-schulleitung", userId: jana, role: "member" });
    const after = (await items(jana)).find((i) => i.id === "abwesenheiten:beurlaubung");
    expect(after?.count).toBe(2);
    await h.db.delete(groupMembers).where(and(eq(groupMembers.groupId, "g-schulleitung"), eq(groupMembers.userId, jana)));
  });

  it("S-02: Eltern sehen offene Anträge nur für minderjährige Kinder", async () => {
    expect((await items(mutter)).find((i) => i.id === "abwesenheiten:beurlaubung-beantragt")?.count).toBe(2);
    // Q5-05: Kennzeichen „eigenständig (volljährig)“ am Konto
    await h.db.update(users).set({ selfResponsible: true }).where(eq(users.id, lea));
    try {
      expect((await items(mutter)).find((i) => i.id === "abwesenheiten:beurlaubung-beantragt")).toBeUndefined();
    } finally {
      await h.db.update(users).set({ selfResponsible: false }).where(eq(users.id, lea));
    }
  });

  it("C-10: Hinweis für die Rechteverwaltung, solange außer Admins niemand über der Grenze entscheiden darf", async () => {
    const hint = async (u: string) => (await items(u)).some((i) => i.id === "abwesenheiten:leave-decide-fehlt");
    expect(await hint("u-admin")).toBe(false); // Demo: Gruppe Schulleitung hat das Recht
    const [g] = await h.db.delete(grants).where(and(eq(grants.permission, "abwesenheiten.leave_decide"), eq(grants.groupId, "g-schulleitung"))).returning();
    expect(await hint("u-admin")).toBe(true);
    expect(await hint(jana)).toBe(false); // ohne `verwaltung.rights`
    await h.db.insert(grants).values(g!);
  });
});
