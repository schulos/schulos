import { describe, expect, it } from "vitest";
import { backupHealth, berlinStamp, dueSlot, restoreRequestProblem, type RestoreRequest } from "./agent-api";

// 2026-10-05 ist Sommerzeit (UTC+2)
const at = (iso: string) => new Date(iso);

describe("dueSlot", () => {
  it("fällig nach der Uhrzeit, nicht davor, nicht doppelt", () => {
    expect(dueSlot(["01:30"], at("2026-10-04T23:29:00Z"), null)).toBeNull(); // 01:29 Berlin
    expect(dueSlot(["01:30"], at("2026-10-04T23:30:00Z"), null)).toBe("2026-10-05 01:30");
    expect(dueSlot(["01:30"], at("2026-10-05T03:00:00Z"), "2026-10-05 01:30")).toBeNull();
  });

  it("holt einen verpassten Termin bis 12 h nach, danach nicht mehr; nur den jüngsten", () => {
    expect(dueSlot(["01:30"], at("2026-10-05T11:00:00Z"), "2026-10-04 01:30")).toBe("2026-10-05 01:30"); // 13:00 Berlin
    expect(dueSlot(["01:30"], at("2026-10-05T12:00:00Z"), "2026-10-04 01:30")).toBeNull(); // 14:00 Berlin
    expect(dueSlot(["01:30", "12:00"], at("2026-10-05T10:30:00Z"), null)).toBe("2026-10-05 12:00");
  });

  it("kurz nach Mitternacht zählt der Termin von gestern Abend; Winterzeit wird berücksichtigt", () => {
    expect(dueSlot(["23:00"], at("2026-10-04T22:10:00Z"), null)).toBe("2026-10-04 23:00"); // 00:10 Berlin am 5.
    expect(berlinStamp(at("2026-12-01T00:30:00Z"))).toBe("2026-12-01 01:30");
    expect(dueSlot(["kaputt", "25:00"], at("2026-10-05T10:00:00Z"), null)).toBeNull();
  });
});

describe("backupHealth", () => {
  const now = at("2026-10-05T10:00:00Z");
  it("Ampel", () => {
    expect(backupHealth(null, null, now)).toBe("none");
    expect(backupHealth(at("2026-10-05T00:00:00Z"), { status: "ok" }, now)).toBe("ok");
    expect(backupHealth(at("2026-10-05T00:00:00Z"), { status: "failed" }, now)).toBe("failed");
    expect(backupHealth(at("2026-10-04T07:00:00Z"), { status: "ok" }, now)).toBe("overdue");
    expect(backupHealth(null, { status: "ok" }, now)).toBe("overdue");
  });
});

describe("restoreRequestProblem (SEC-06)", () => {
  const ok: RestoreRequest = {
    id: "0b6f1f9e-4b8a-4c1e-9a43-0c1d2e3f4a5b",
    snapshotId: "7da39b69".padEnd(64, "e"),
    snapshotShort: "7da39b69",
    snapshotTime: "2026-10-04T23:30:00Z",
    scope: "komplett",
    requestedBy: null,
    createdAt: "2026-10-05T08:00:00Z",
    status: "wartet",
  };
  it("nur volle Snapshot-IDs, passende Kurzform, bekannte Umfänge", () => {
    expect(restoreRequestProblem(ok)).toBeNull();
    expect(restoreRequestProblem({ ...ok, snapshotId: "7da39b69" })).toMatch(/Stand/);
    expect(restoreRequestProblem({ ...ok, snapshotId: `--password-command=x${"a".repeat(45)}` })).toMatch(/Stand/);
    expect(restoreRequestProblem({ ...ok, snapshotShort: "ffffffff" })).toMatch(/Kurzform/);
    expect(restoreRequestProblem({ ...ok, scope: "alles" as never })).toMatch(/Umfang/);
    expect(restoreRequestProblem({ ...ok, id: "../x" })).toMatch(/Auftragsnummer/);
    expect(restoreRequestProblem(null)).toBeTruthy();
  });
});
