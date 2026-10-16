// Notenbuch (P5-12): Inaktivitätsablauf je Sitzung – nach 15 Minuten ohne Aktivität gesperrt, bleibt gesperrt, nur eine neue
// Sitzung (neue Anmeldung) öffnet wieder; Sitzung gehört genau einem Konto; Löschen der Sitzung räumt mit auf.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { notenbuchSessions, sessions } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { idleExpired, IDLE_MINUTES, lockNotenbuchSession, notenbuchSessionLocked, touchNotenbuchSession } from "./sitzung";

const JANA = "u-jana.brandt";
const TOBIAS = "u-tobias.kleine";
const T0 = new Date("2026-10-07T08:00:00Z");
const after = (min: number) => new Date(T0.getTime() + min * 60_000);

describe("Notenbuch: Inaktivitätsablauf", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    const s = (id: string, userId: string) => ({ id, token: `t-${id}`, userId, expiresAt: after(60 * 24) });
    await h.db.insert(sessions).values([s("s1", JANA), s("s2", JANA), s("s3", TOBIAS)]);
  }, 60_000);
  afterAll(() => h.close());

  it("rein: 15 Minuten, Grenze einschließlich", () => {
    expect(IDLE_MINUTES).toBe(15);
    expect(idleExpired(T0, after(15))).toBe(false);
    expect(idleExpired(T0, new Date(after(15).getTime() + 1))).toBe(true);
  });

  it("Aktivität verlängert; nach 15 Minuten Ruhe gesperrt – und bleibt es", async () => {
    expect(await touchNotenbuchSession(h.db, "s1", JANA, T0)).toBe("ok");
    expect(await touchNotenbuchSession(h.db, "s1", JANA, after(10))).toBe("ok");
    expect(await touchNotenbuchSession(h.db, "s1", JANA, after(24))).toBe("ok"); // 14 min nach der letzten Aktivität
    expect(await notenbuchSessionLocked(h.db, "s1", JANA, after(39))).toBe(false);
    expect(await notenbuchSessionLocked(h.db, "s1", JANA, after(40))).toBe(true);
    expect(await touchNotenbuchSession(h.db, "s1", JANA, after(40))).toBe("locked");
    // später wieder aktiv: bleibt gesperrt
    expect(await touchNotenbuchSession(h.db, "s1", JANA, after(41))).toBe("locked");
    const [row] = await h.db.select().from(notenbuchSessions).where(eq(notenbuchSessions.sessionId, "s1"));
    expect(row!.lockedAt).toEqual(after(40));
    // eine neue Sitzung (neue Anmeldung) beginnt frisch
    expect(await touchNotenbuchSession(h.db, "s2", JANA, after(41))).toBe("ok");
  });

  it("die Seite sperrt sofort; eine fremde Sitzung gilt als gesperrt", async () => {
    await lockNotenbuchSession(h.db, "s2", JANA, after(42));
    expect(await touchNotenbuchSession(h.db, "s2", JANA, after(42))).toBe("locked");
    expect(await touchNotenbuchSession(h.db, "s3", TOBIAS, after(42))).toBe("ok");
    expect(await touchNotenbuchSession(h.db, "s3", JANA, after(43))).toBe("locked");
    expect(await notenbuchSessionLocked(h.db, "s3", JANA, after(43))).toBe(true);
    // eine noch nie im Notenbuch genutzte Sitzung ist nicht gesperrt (ohne Zeile)
    expect(await notenbuchSessionLocked(h.db, "s-keine", JANA, after(44))).toBe(false);
  });

  it("Abmelden (Sitzung gelöscht) räumt die Zeile mit ab", async () => {
    await h.db.delete(sessions).where(eq(sessions.id, "s1"));
    expect(await h.db.select().from(notenbuchSessions).where(eq(notenbuchSessions.sessionId, "s1"))).toEqual([]);
  });
});
