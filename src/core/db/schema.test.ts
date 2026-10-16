import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "./client";
import { grants, groupMembers, groups, users } from "./schema";
import { createTestDb } from "./testing";

describe("Core-Schema", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values([
      { id: "u1", name: "Jana Brandt", email: "bra@lindenhof.test", role: "lehrkraft", shortCode: "BRA" },
      { id: "u2", name: "Lea Schäfer", email: "lea@lindenhof.test" },
    ]);
  });
  afterAll(() => h.close());

  it("setzt Defaults für Rolle und Status", async () => {
    const [lea] = await h.db.select().from(users).where(eq(users.id, "u2"));
    expect(lea?.role).toBe("schueler");
    expect(lea?.status).toBe("active");
  });

  it("verknüpft Gruppen und Mitglieder", async () => {
    const [g] = await h.db.insert(groups).values({ name: "Klasse 7b", slug: "7b", kind: "klasse", gradeLevel: 7 }).returning();
    await h.db.insert(groupMembers).values([
      { groupId: g!.id, userId: "u1", role: "leader" },
      { groupId: g!.id, userId: "u2" },
    ]);
    const members = await h.db.select().from(groupMembers).where(eq(groupMembers.groupId, g!.id));
    expect(members).toHaveLength(2);
  });

  it("erlaubt Grants nur mit genau einem Ziel (Rolle XOR Gruppe)", async () => {
    await h.db.insert(grants).values({ permission: "news.write", role: "lehrkraft" });
    await expect(h.db.insert(grants).values({ permission: "news.write" })).rejects.toThrow();
    const [g] = await h.db.select().from(groups).limit(1);
    await expect(
      h.db.insert(grants).values({ permission: "news.write", role: "admin", groupId: g!.id }),
    ).rejects.toThrow();
  });

  it("löscht Mitgliedschaften mit, wenn ein Benutzer gelöscht wird", async () => {
    await h.db.delete(users).where(eq(users.id, "u2"));
    const rest = await h.db.select().from(groupMembers).where(eq(groupMembers.userId, "u2"));
    expect(rest).toHaveLength(0);
  });
});
