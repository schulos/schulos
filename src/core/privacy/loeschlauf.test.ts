import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, notifications, privacyDeletionRuns } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ValidationError } from "@/modules/verwaltung/users";
import { activeHolds, createHold, cutoffFor, endHold, listRuns, planDeletion, runDeletion } from "./loeschlauf";

describe("cutoffFor", () => {
  it("rechnet Fristen je Löschklasse", () => {
    const years = ["2026-07-31", "2027-07-31"];
    expect(cutoffFor("LK-90", "2026-10-05", years)).toBe("2026-07-07");
    expect(cutoffFor("LK-1J", "2026-10-05", years)).toBe("2025-10-05");
    expect(cutoffFor("LK-TERMIN", "2026-10-05", years)).toBe("2024-10-05");
    // Schuljahresende: alles bis zum Ende des letzten abgeschlossenen Schuljahres
    expect(cutoffFor("LK-SJ", "2026-10-05", years)).toBe("2026-08-01");
    expect(cutoffFor("LK-SJ-1J", "2026-10-05", years)).toBeNull();
    expect(cutoffFor("LK-SJ-1J", "2028-09-01", years)).toBe("2027-08-01");
  });
});

describe("Löschlauf (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Vorschau: fällige Tabellen mit Anzahl, ausgelassene mit Begründung; Teilmengen nur mit Regel", async () => {
    const plan = await planDeletion(h.db, "2026-10-05");
    expect(plan.find((p) => p.table === "users")).toMatchObject({ status: "due", count: 0 });
    expect(plan.find((p) => p.table === "audit_log")).toMatchObject({ status: "due", mode: "pseudonymize", scope: "pseudonymisieren" });
    expect(plan.find((p) => p.table === "chat_rooms" && p.scope === "Direktchat")).toMatchObject({ status: "due" });
    expect(plan.find((p) => p.table === "notifications")).toMatchObject({ status: "due" });
    expect(plan.every((p) => p.count >= 0)).toBe(true);
  });

  it("löscht Fälliges, protokolliert Anzahlen; Löschsperre nimmt eine Person aus", async () => {
    const old = new Date("2026-01-02T10:00:00Z");
    await h.db.insert(notifications).values([
      { userId: "u-lea.schaefer", moduleId: "news", title: "alt Lea", createdAt: old },
      { userId: "u-jana.brandt", moduleId: "news", title: "alt Jana", createdAt: old },
    ]);
    await expect(
      createHold(h.db, "u-admin", { userId: "u-lea.schaefer", groupId: null, reason: "kurz", until: "2026-12-31" }, "2026-10-05"),
    ).rejects.toBeInstanceOf(ValidationError);
    const hold = await createHold(
      h.db,
      "u-admin",
      { userId: "u-lea.schaefer", groupId: null, reason: "Widerspruchsverfahren Zeugnis", until: "2026-12-31" },
      "2026-10-05",
    );
    expect((await activeHolds(h.db, "2026-10-05")).map((x) => x.userName)).toEqual(["Lea Schäfer"]);

    const before = (await planDeletion(h.db, "2026-10-05")).find((p) => p.table === "notifications")!.count;
    expect(before).toBeGreaterThanOrEqual(1);
    const run = await runDeletion(h.db, "u-admin", "2026-10-05");
    expect(run.items.find((i) => i.table === "notifications")!.deleted).toBe(before);
    const left = await h.db.select({ title: notifications.title }).from(notifications);
    expect(left.map((n) => n.title)).toContain("alt Lea");
    expect(left.map((n) => n.title)).not.toContain("alt Jana");
    expect((await planDeletion(h.db, "2026-10-05")).find((p) => p.table === "notifications")!.count).toBe(0);
    const [protocol] = await listRuns(h.db);
    expect(protocol).toMatchObject({ id: run.id, triggeredBy: "u-admin", total: run.total });
    expect(JSON.stringify(protocol!.result)).not.toContain("alt Jana"); // nur Anzahlen
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.loeschlauf"))).length).toBe(1);

    await endHold(h.db, "u-admin", hold);
    expect(await activeHolds(h.db, "2026-10-05")).toEqual([]);
  });

  it("Lauf in der Zukunft (alle Demo-Fristen abgelaufen) löscht ohne Fremdschlüssel-Fehler", async () => {
    const run = await runDeletion(h.db, null, "2029-09-01");
    expect(run.items.filter((i) => i.error)).toEqual([]);
    expect(run.total).toBeGreaterThan(0);
    const again = await planDeletion(h.db, "2029-09-01");
    // übrig ist nur das eben geschriebene Protokoll (echtes Datum, aus Sicht von 2029 längst fällig)
    expect(again.filter((p) => p.status === "due" && p.count > 0).map((p) => p.table)).toEqual(["privacy_deletion_runs"]);
    expect((await h.db.select().from(privacyDeletionRuns)).map((r) => r.id)).toEqual([run.id]);
  }, 60_000);
});
