import { describe, expect, it } from "vitest";
import { DEFAULT_RETENTION, parseRetention, parseSchedule, preview, retentionFromEnv } from "./backup-retention";

describe("Aufbewahrung", () => {
  it("Vorschau: Vorgabe 14/4/3 → höchstens 21 Stände, älteste ≈ 3 Monate, ohne Begründung", () => {
    expect(preview(DEFAULT_RETENTION)).toEqual({ maxSnapshots: 21, oldestDays: 91, oldestLabel: "≈ 3 Monate", needsReason: false });
    expect(preview({ daily: 14, weekly: 4, monthly: 0 }).oldestLabel).toBe("4 Wochen");
    expect(preview({ daily: 7, weekly: 0, monthly: 0 }).oldestLabel).toBe("7 Tage");
    expect(preview({ daily: 14, weekly: 4, monthly: 6 })).toMatchObject({ oldestLabel: "≈ 6 Monate", needsReason: true });
  });

  it("Eingaben: Grenzen je Stufe, über 3 Monate nur mit Begründung", () => {
    expect(parseRetention({ daily: "14", weekly: "4", monthly: "3", reason: "" })).toEqual({ ok: true, retention: DEFAULT_RETENTION, reason: null });
    expect(parseRetention({ daily: "0", weekly: "4", monthly: "x", reason: "" })).toEqual({ ok: false, errors: { daily: "1 bis 60", monthly: "0 bis 24" } });
    expect(parseRetention({ daily: "14", weekly: "4", monthly: "12", reason: "kurz" })).toMatchObject({ ok: false, errors: { reason: expect.stringContaining("Begründung") } });
    expect(parseRetention({ daily: "14", weekly: "4", monthly: "12", reason: "Schulträger verlangt Jahresstände" })).toMatchObject({
      ok: true,
      reason: "Schulträger verlangt Jahresstände",
    });
  });

  it("Vorgabe aus der Umgebung (Installer): 14/4/3 ohne Angabe, über 3 Monate nur mit Begründung, Unsinn bricht ab", () => {
    expect(retentionFromEnv({})).toEqual({ retention: DEFAULT_RETENTION, reason: null });
    expect(retentionFromEnv({ SCHULOS_RETENTION: "7/2/0" })).toEqual({ retention: { daily: 7, weekly: 2, monthly: 0 }, reason: null });
    expect(retentionFromEnv({ SCHULOS_RETENTION: "14/4/6", SCHULOS_RETENTION_REASON: "Schulträger verlangt Halbjahresstände" })).toEqual({
      retention: { daily: 14, weekly: 4, monthly: 6 },
      reason: "Schulträger verlangt Halbjahresstände",
    });
    expect(() => retentionFromEnv({ SCHULOS_RETENTION: "14/4/6" })).toThrow(/Begründung/);
    expect(() => retentionFromEnv({ SCHULOS_RETENTION: "viel" })).toThrow(/SCHULOS_RETENTION/);
  });

  it("Zeitplan: HH:MM, sortiert, ohne Dubletten, 1–4 Uhrzeiten", () => {
    expect(parseSchedule("12:30, 1:30 01:30")).toEqual({ ok: true, schedule: ["01:30", "12:30"] });
    expect(parseSchedule("")).toMatchObject({ ok: false });
    expect(parseSchedule("25:00")).toMatchObject({ ok: false });
    expect(parseSchedule("01:00 02:00 03:00 04:00 05:00")).toMatchObject({ ok: false, error: expect.stringContaining("vier") });
  });
});
