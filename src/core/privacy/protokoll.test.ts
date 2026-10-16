import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { audit, auditRead } from "@/core/audit";
import { auditLog, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { listAudit } from "@/modules/verwaltung/audit-view";
import { deleteAccounts } from "./konto";
import { createHold, planDeletion, runDeletion } from "./loeschlauf";
import { auditPepper, isPseudonym, pseudonymizeRow, pseudonymOf } from "./protokoll";

describe("pseudonymizeRow (rein)", () => {
  const pseudo = (u: string) => `P-${u.length.toString(16).padStart(10, "0")}`;
  const isUser = (s: string) => s.startsWith("u-");

  it("ersetzt Handelnde, Ziel und Konto-IDs in meta; Namen fallen weg, wenn das Ziel eine Person ist", () => {
    const out = pseudonymizeRow(
      { actorId: "u-admin", actorPseudonym: null, target: "u-lea.schaefer", meta: { name: "Lea Schäfer", follows: "u-max", leftOn: "2026-10-01" } },
      pseudo,
      isUser,
    );
    expect(out.actorId).toBeNull();
    expect(out.actorPseudonym).toBe(pseudo("u-admin"));
    expect(out.target).toBe(pseudo("u-lea.schaefer"));
    expect(out.meta).toEqual({ follows: pseudo("u-max"), leftOn: "2026-10-01" });
  });

  it("lässt Gruppen-Ziele, Gruppennamen und Zahlen stehen; Listen von Konten werden ersetzt", () => {
    const out = pseudonymizeRow(
      { actorId: "u-admin", actorPseudonym: null, target: "g-7b", meta: { name: "7b", userIds: ["u-a", "u-bb"], count: 2 } },
      pseudo,
      isUser,
    );
    expect(out.target).toBe("g-7b");
    expect(out.meta).toEqual({ name: "7b", userIds: [pseudo("u-a"), pseudo("u-bb")], count: 2 });
  });

  it("Pseudonym ist stabil je Person und Geheimnis", () => {
    expect(pseudonymOf("k1", "u-a")).toBe(pseudonymOf("k1", "u-a"));
    expect(pseudonymOf("k1", "u-a")).not.toBe(pseudonymOf("k1", "u-b"));
    expect(pseudonymOf("k1", "u-a")).not.toBe(pseudonymOf("k2", "u-a"));
    expect(isPseudonym(pseudonymOf("k1", "u-a"))).toBe(true);
    expect(isPseudonym("u-a")).toBe(false);
  });
});

describe("Audit-Log mit Frist (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Lesezugriffe: innerhalb von 30 Minuten je Person, Art und Ziel nur einmal", async () => {
    const t0 = new Date("2026-10-04T08:00:00Z");
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.klassenbuch", "g-x", {}, t0)).toBe(true);
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.klassenbuch", "g-x", {}, new Date(t0.getTime() + 10 * 60_000))).toBe(false);
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.klassenbuch", "g-y", {}, new Date(t0.getTime() + 10 * 60_000))).toBe(true);
    expect(await auditRead(h.db, "u-petra.lindner", "lesen.klassenbuch", "g-x", {}, new Date(t0.getTime() + 10 * 60_000))).toBe(true);
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.klassenbuch", "g-x", {}, new Date(t0.getTime() + 31 * 60_000))).toBe(true);
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.abwesenheiten", null, {}, t0)).toBe(true);
    expect(await auditRead(h.db, "u-jana.brandt", "lesen.abwesenheiten", null, {}, new Date(t0.getTime() + 60_000))).toBe(false);
    const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, "lesen.klassenbuch"));
    expect(rows).toHaveLength(4);
  });

  it("Löschlauf pseudonymisiert Einträge älter als ein Jahr; Löschsperre hält den Klarnamen", async () => {
    const old = new Date("2025-03-01T10:00:00Z");
    await h.db.insert(auditLog).values([
      { actorId: "u-sabine.kowalski", action: "verwaltung.user.left", target: "u-lea.schaefer", meta: { leftOn: "2025-03-01" }, createdAt: old },
      { actorId: "u-jana.brandt", action: "lesen.klassenbuch", target: "g-7b", meta: {}, createdAt: old },
      { actorId: "u-petra.lindner", action: "verwaltung.user.lock", target: "u-admin", meta: {}, createdAt: old },
    ]);
    await audit(h.db, "u-sabine.kowalski", "verwaltung.user.unlock", "u-lea.schaefer");
    await createHold(h.db, "u-admin", { userId: "u-petra.lindner", groupId: null, reason: "Widerspruchsverfahren", until: "2027-01-01" }, "2026-10-04");

    const plan = await planDeletion(h.db, "2026-10-04");
    expect(plan.find((p) => p.table === "audit_log")).toMatchObject({ status: "due", count: 2 });
    const res = await runDeletion(h.db, "u-admin", "2026-10-04");
    expect(res.items.find((i) => i.table === "audit_log")).toMatchObject({ scope: "pseudonymisieren", deleted: 2 });

    const pepper = await auditPepper(h.db);
    const rows = await h.db.select().from(auditLog).where(inArray(auditLog.createdAt, [old]));
    const left = rows.find((r) => r.action === "verwaltung.user.left")!;
    expect(left).toMatchObject({ actorId: null, actorPseudonym: pseudonymOf(pepper, "u-sabine.kowalski"), target: pseudonymOf(pepper, "u-lea.schaefer") });
    expect(left.pseudonymizedAt).not.toBeNull();
    expect(rows.find((r) => r.action === "lesen.klassenbuch")).toMatchObject({ actorId: null, target: "g-7b" });
    // gesperrt: Petra Lindner bleibt im Klartext
    expect(rows.find((r) => r.action === "verwaltung.user.lock")).toMatchObject({ actorId: "u-petra.lindner", pseudonymizedAt: null });
    // jung: unverändert
    const [fresh] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.unlock"));
    expect(fresh).toMatchObject({ actorId: "u-sabine.kowalski", target: "u-lea.schaefer" });
    // zweiter Lauf: nichts mehr fällig
    expect((await planDeletion(h.db, "2026-10-04")).find((p) => p.table === "audit_log")!.count).toBe(0);

    // Ansicht: Pseudonym statt Name, kein Klarname mehr im Eintrag
    const { rows: view } = await listAudit(h.db, { prefix: "verwaltung.user.left" });
    const shown = view.find((v) => v.id === left.id)!;
    expect(shown.actor).toBe(`Pseudonym ${pseudonymOf(pepper, "u-sabine.kowalski")}`);
    expect(shown.target).toBe(`Pseudonym ${pseudonymOf(pepper, "u-lea.schaefer")}`);
    expect(shown.pseudonymized).toBe(true);
  });

  it("Kontolöschung pseudonymisiert alle Einträge der Person sofort – auch junge und Erwähnungen in meta", async () => {
    const [u] = await h.db.insert(users).values({ id: "u-tmp.person", name: "Tmp Person", email: "tmp.person@t", role: "schueler" }).returning();
    await audit(h.db, "u-admin", "verwaltung.user.create", u!.id, { role: "schueler" });
    await audit(h.db, "u-admin", "verwaltung.group.members_add", "g-7b", { userIds: [u!.id, "u-lea.schaefer"] });
    await audit(h.db, u!.id, "datenschutz.eigenexport", u!.id, {});
    expect(await deleteAccounts(h.db, [u!.id])).toBe(1);

    const pepper = await auditPepper(h.db);
    const p = pseudonymOf(pepper, u!.id);
    const all = await h.db.select().from(auditLog);
    expect(JSON.stringify(all)).not.toContain("tmp.person");
    expect(all.find((r) => r.action === "datenschutz.eigenexport")).toMatchObject({ actorId: null, actorPseudonym: p, target: p });
    expect(all.find((r) => r.action === "verwaltung.group.members_add" && r.target === "g-7b" && r.pseudonymizedAt)!.meta).toEqual({
      userIds: [p, pseudonymOf(pepper, "u-lea.schaefer")],
    });
  });
});
