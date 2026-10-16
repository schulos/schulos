import { describe, expect, it } from "vitest";
import { systemJobs } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { fromBerlinLocal } from "@/core/time";
import { dueWindow, jobsEnabled, runExclusive, tick, tryAcquire, type ScheduledJob } from "./jobs";

const at = (local: string) => fromBerlinLocal(local);

describe("Hintergrundjobs", () => {
  it("Fenster: nur zwischen Beginn und Ende, einmal je Berliner Kalendertag", () => {
    const job = { at: "02:30", until: "06:00" };
    expect(dueWindow(job, at("2026-10-05T02:29"))).toBeNull();
    expect(dueWindow(job, at("2026-10-05T06:00"))).toBeNull();
    expect(dueWindow(job, at("2026-10-05T14:00"))).toBeNull();
    expect(dueWindow(job, at("2026-10-05T03:17"))).toEqual(at("2026-10-05"));
    // Umstellung auf Winterzeit: 02:30 gibt es zweimal – beide liegen am selben Tag, also nur ein Lauf
    expect(dueWindow(job, new Date("2026-10-25T00:45:00Z"))).toEqual(at("2026-10-25"));
    expect(dueWindow(job, new Date("2026-10-25T01:45:00Z"))).toEqual(at("2026-10-25"));
  });

  it("schaltet sich im Container ein, in der Entwicklung nur auf Wunsch", () => {
    expect(jobsEnabled({})).toBe(false);
    expect(jobsEnabled({ SCHULOS_JOBS: "1" })).toBe(true);
    expect(jobsEnabled({ SCHULOS_INSTANCE: "production" })).toBe(true);
    expect(jobsEnabled({ SCHULOS_INSTANCE: "demo", SCHULOS_JOBS: "0" })).toBe(false);
  });

  it("Sperre: zweiter Lauf wartet nicht, sondern entfällt; abgelaufene Sperre wird frei", async () => {
    const h = await createTestDb();
    const now = new Date("2026-10-05T01:00:00Z");
    expect(await tryAcquire(h.db, "x", "a", 60_000, now)).toBe(true);
    expect(await tryAcquire(h.db, "x", "b", 60_000, new Date(now.getTime() + 30_000))).toBe(false);
    // Prozess „a“ abgestürzt: nach Ablauf darf „b“
    expect(await tryAcquire(h.db, "x", "b", 60_000, new Date(now.getTime() + 61_000))).toBe(true);
    await h.close();
  });

  it("runExclusive: parallel gestartet läuft genau einer; Fehler werden festgehalten und geben die Sperre frei", async () => {
    const h = await createTestDb();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = runExclusive(h.db, "solver", async () => {
      calls++;
      await gate;
      return 42;
    });
    // erst prüfen, wenn der erste Lauf die Sperre sicher hält (unter PostgreSQL dauert tryAcquire länger als ein fester Takt)
    for (let i = 0; calls === 0 && i < 500; i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(await runExclusive(h.db, "solver", async () => calls++)).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, result: 42 });
    expect(calls).toBe(1);

    expect(await runExclusive(h.db, "solver", async () => Promise.reject(new Error("kaputt")))).toEqual({ ran: true, error: "kaputt" });
    const [row] = await h.db.select().from(systemJobs);
    expect(row).toMatchObject({ name: "solver", lockedUntil: null, lastStatus: "failed", lastError: "kaputt" });
    expect((await runExclusive(h.db, "solver", async () => "wieder frei")).result).toBe("wieder frei");
    await h.close();
  });

  it("Nachtjob läuft einmal pro Nacht – auch wenn zwei Prozesse takten", async () => {
    const h = await createTestDb();
    const runs: string[] = [];
    const job: ScheduledJob = { name: "loeschlauf", at: "02:30", until: "06:00", ttlMs: 60_000, run: async (_db, now) => void runs.push(now.toISOString()) };
    expect(await tick(h.db, [job], at("2026-10-05T01:00"))).toEqual([]);
    expect(await tick(h.db, [job], at("2026-10-05T02:31"))).toEqual([{ name: "loeschlauf", ran: true }]);
    // zweiter Prozess bzw. nächster Takt in derselben Nacht
    expect(await tick(h.db, [job], at("2026-10-05T02:32"))).toEqual([]);
    expect(await tick(h.db, [job], at("2026-10-05T05:59"))).toEqual([]);
    // nächste Nacht wieder
    expect(await tick(h.db, [job], at("2026-10-06T03:00"))).toEqual([{ name: "loeschlauf", ran: true }]);
    expect(runs).toHaveLength(2);
    await h.close();
  });
});
