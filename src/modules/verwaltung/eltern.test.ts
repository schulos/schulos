import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, parentChild, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { createParentForChild, linkParent, linkParentByUsername, MAX_PARENTS, unlinkParent } from "./eltern";
import { getUserDetail } from "./users";

describe("Elternkonten in der Benutzerverwaltung (P4-38)", () => {
  let h: DbHandle;
  const actor = "u-sabine.kowalski";
  const child = "u-lea.schaefer";

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => h?.close());

  const parentsOf = async (id: string) => (await h.db.select({ p: parentChild.parentId }).from(parentChild).where(eq(parentChild.childId, id))).map((r) => r.p);

  it("neues Elternkonto: Rolle Eltern, Startpasswort, E-Mail unbestätigt, verknüpft, im Protokoll", async () => {
    const before = await parentsOf(child);
    const r = await createParentForChild(h.db, actor, child, { firstName: "Maren", lastName: "Schäfer", email: "Maren.Schaefer@Example.org" });
    expect(r.username).toMatch(/^maren\.schaefer\d*$/);
    expect(r.password.length).toBeGreaterThanOrEqual(10);
    const [u] = await h.db.select().from(users).where(eq(users.id, r.id));
    expect(u).toMatchObject({ role: "eltern", email: "maren.schaefer@example.org", emailVerified: false, mustChangePassword: true });
    expect(await parentsOf(child)).toEqual([...before, r.id]);
    expect((await getUserDetail(h.db, child))!.parents.map((p) => p.id)).toContain(r.id);
    const [log] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "verwaltung.eltern.verknuepft"), eq(auditLog.target, child)));
    expect(log!.meta).toMatchObject({ eltern: r.id, neu: true });
    // dieselbe Adresse ein zweites Mal geht nicht (eindeutig, Q5-04)
    await expect(createParentForChild(h.db, actor, child, { firstName: "X", lastName: "Y", email: "maren.schaefer@example.org" })).rejects.toMatchObject({ fieldErrors: { email: expect.any(String) } });
  });

  it("vorhandenes Elternkonto verknüpfen und lösen; nur Eltern ↔ Schüler:in", async () => {
    const [other] = await h.db.select({ id: users.id, username: users.username }).from(users).where(eq(users.role, "eltern")).limit(1);
    const [kid] = await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "schueler"), eq(users.username, "lea.schaefer")));
    await unlinkParent(h.db, actor, other!.id, kid!.id); // falls der Seed sie zufällig verknüpft hat
    expect(await linkParentByUsername(h.db, actor, kid!.id, ` ${other!.username!.toUpperCase()} `)).toBe(true);
    expect(await linkParent(h.db, actor, other!.id, kid!.id)).toBe(false);
    expect(await parentsOf(kid!.id)).toContain(other!.id);
    await unlinkParent(h.db, actor, other!.id, kid!.id);
    expect(await parentsOf(kid!.id)).not.toContain(other!.id);
    // Elternkonto bleibt bestehen
    expect(await h.db.select().from(users).where(eq(users.id, other!.id))).toHaveLength(1);
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.eltern.geloest"))).toHaveLength(1);
    await expect(linkParentByUsername(h.db, actor, kid!.id, "jana.brandt")).rejects.toMatchObject({ fieldErrors: { username: /Elternkonto/ } });
    await expect(linkParent(h.db, actor, "u-jana.brandt", kid!.id)).rejects.toMatchObject({ fieldErrors: { parent: /Rolle Eltern/ } });
    await expect(linkParent(h.db, actor, other!.id, "u-jana.brandt")).rejects.toMatchObject({ fieldErrors: { parent: /Schüler/ } });
    await expect(createParentForChild(h.db, actor, "u-jana.brandt", { firstName: "A", lastName: "B" })).rejects.toThrow();
  });

  it("höchstens MAX_PARENTS Elternkonten je Kind", async () => {
    const [kid] = await h.db.select({ id: users.id }).from(users).where(and(eq(users.role, "schueler"), eq(users.username, "lea.schaefer")));
    for (let i = (await parentsOf(kid!.id)).length; i < MAX_PARENTS; i++) await createParentForChild(h.db, actor, kid!.id, { firstName: "Patch", lastName: `Work${i}` });
    await expect(createParentForChild(h.db, actor, kid!.id, { firstName: "Zu", lastName: "Viel" })).rejects.toMatchObject({ fieldErrors: { firstName: /Höchstens/ } });
  });
});
