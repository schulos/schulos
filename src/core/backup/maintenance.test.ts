import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINTENANCE_FILE } from "@schulos/server/agent-api";
import { maintenancePage, readMaintenance, watchMaintenance } from "./maintenance";

describe("Wartungsmodus", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  });
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), "schulos-wartung-"));
    dirs.push(d);
    return d;
  };

  it("ohne Datei kein Wartungsmodus; Seite ohne Skripte, Text maskiert", () => {
    const dir = tmp();
    expect(readMaintenance(dir)).toBeNull();
    writeFileSync(path.join(dir, MAINTENANCE_FILE), JSON.stringify({ since: "x", reason: "Wiederherstellung <b>", phase: "wartung" }));
    const m = readMaintenance(dir)!;
    expect(m.phase).toBe("wartung");
    const html = maintenancePage(m);
    expect(html).toContain("Wiederherstellung &lt;b&gt;");
    expect(html).not.toContain("<script");
  });

  it("Phase „neustart“: Datei weg, Prozess beendet sich (Docker startet neu)", () => {
    vi.useFakeTimers();
    const dir = tmp();
    const exit = vi.fn();
    watchMaintenance(dir, exit);
    vi.advanceTimersByTime(3500);
    expect(exit).not.toHaveBeenCalled();
    writeFileSync(path.join(dir, MAINTENANCE_FILE), JSON.stringify({ since: "x", reason: "fertig", phase: "neustart" }));
    vi.advanceTimersByTime(3500);
    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(path.join(dir, MAINTENANCE_FILE))).toBe(false);
  });
});
