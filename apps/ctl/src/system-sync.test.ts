import { describe, expect, it } from "vitest";
import { buildManifest, planUpdate, type ReleaseManifest } from "@schulos/server/release";
import { buildStatus, nextRebootState, orderEffect, protocolTail, windowDecision } from "./system-sync";

const d64 = (c: string) => "sha256:" + c.repeat(64);
const rel = (version: string): ReleaseManifest =>
  buildManifest({
    version,
    notes: { betaDays: 0, changes: [{ kind: "neu", text: `Neu in ${version}` }] },
    images: { app: `ghcr.io/x/a@${d64("a")}`, backup: `ghcr.io/x/b@${d64("b")}`, agent: `ghcr.io/x/c@${d64("c")}` },
    commit: "abc1234",
    publishedAt: new Date("2026-09-01T00:00:00Z"),
  });
const now = new Date("2026-10-05T10:00:00Z");
const order = { version: 1 as const, id: "auftrag-1", createdAt: "2026-10-05T09:00:00Z", by: "u-admin" };

describe("system-sync", () => {
  it("Protokoll: neueste zuerst, kaputte Zeilen übersprungen", () => {
    const jsonl = ['{"at":"1","step":"plan","ok":true}', '{"at":"2","step":"fertig"', '{"at":"3","step":"fertig","ok":true}', ""].join("\n");
    expect(protocolTail(jsonl).map((e) => e.at)).toEqual(["3", "1"]);
    expect(protocolTail(jsonl, 1).map((e) => e.at)).toEqual(["3"]);
  });

  it("Status mit verfügbarem Update; erledigte Freigabe fällt weg", () => {
    const plan = planUpdate("1.4.0", [rel("1.4.1"), rel("1.5.0")], "stabil", now);
    const s = buildStatus({ now, current: "1.4.0", channel: "stabil", plan, approved: { version: "1.5.0", by: "u-admin", at: "x" }, protocol: [], os: null });
    expect(s.update).toMatchObject({ status: "verfügbar", kind: "minor", steps: [{ version: "1.5.0", changes: [{ text: "Neu in 1.5.0" }] }] });
    expect(s.approved).toMatchObject({ version: "1.5.0" });
    expect(buildStatus({ now, current: "1.5.0", channel: "stabil", plan: null, approved: { version: "1.5.0", by: "u", at: "x" }, protocol: [], os: null, error: "offline" })).toMatchObject({
      update: null,
      approved: null,
      error: "offline",
    });
  });

  it("Aufträge: Kanal, Freigabe jetzt/im Fenster, veraltete Freigabe verworfen", () => {
    const plan = planUpdate("1.4.0", [rel("1.5.0")], "stabil", now);
    expect(orderEffect({ ...order, action: "kanal", channel: "beta" }, plan)).toMatchObject({ kind: "kanal", channel: "beta" });
    expect(orderEffect({ ...order, action: "freigabe", target: "1.5.0", when: "jetzt" }, plan)).toMatchObject({ kind: "jetzt", target: "1.5.0" });
    expect(orderEffect({ ...order, action: "freigabe", target: "1.5.0", when: "wartungsfenster" }, plan)).toEqual({
      kind: "wartungsfenster",
      approval: { version: "1.5.0", by: "u-admin", at: "2026-10-05T09:00:00Z" },
      entry: "Update auf 1.5.0 freigegeben (im Wartungsfenster)",
    });
    expect(orderEffect({ ...order, action: "freigabe", target: "1.4.9", when: "jetzt" }, plan)).toMatchObject({
      kind: "verworfen",
      entry: "Freigabe für 1.4.9 verworfen – verfügbar ist 1.5.0",
    });
  });
});

describe("Neustart mit Passphrase (Q5-18)", () => {
  it("Zustand: nur mit Neustart-Bedarf UND Passphrase, Beginn bleibt stehen, verschwindet nach dem Neustart", () => {
    const later = new Date("2026-10-09T02:30:00Z");
    expect(nextRebootState(null, { required: true, passphrase: true, now })).toEqual({ state: { since: now.toISOString() }, fresh: true });
    expect(nextRebootState({ since: now.toISOString() }, { required: true, passphrase: true, now: later })).toEqual({ state: { since: now.toISOString() }, fresh: false });
    // TPM2: das Wartungsfenster startet selbst neu
    expect(nextRebootState(null, { required: true, passphrase: false, now })).toEqual({ state: null, fresh: false });
    // nach dem Neustart (kein /run/reboot-required mehr)
    expect(nextRebootState({ since: now.toISOString() }, { required: false, passphrase: true, now: later })).toEqual({ state: null, fresh: false });
  });

  it("Status zeigt den ausstehenden Neustart; Auftrag nur, wenn einer aussteht", () => {
    const s = buildStatus({ now, current: "1.4.0", channel: "stabil", plan: null, approved: null, protocol: [], os: null, reboot: { since: "2026-10-01T02:30:00Z" } });
    expect(s.reboot).toEqual({ since: "2026-10-01T02:30:00Z", reason: "passphrase" });
    expect(buildStatus({ now, current: "1.4.0", channel: "stabil", plan: null, approved: null, protocol: [], os: null }).reboot).toBeNull();
    expect(orderEffect({ ...order, action: "neustart" }, null, true)).toMatchObject({ kind: "neustart" });
    expect(orderEffect({ ...order, action: "neustart" }, null, false)).toEqual({ kind: "verworfen", entry: "Neustart verworfen – es steht keiner aus" });
  });
});

describe("Wartungsfenster", () => {
  const approval = { version: "1.5.0", by: "u-admin", at: "x" };
  it("Patch automatisch, Funktions-Update nur mit passender Freigabe", () => {
    expect(windowDecision(planUpdate("1.4.0", [rel("1.4.1")], "stabil", now), null)).toEqual({ run: true, approved: false, reason: "Patch 1.4.1 automatisch" });
    const minor = planUpdate("1.4.0", [rel("1.5.0")], "stabil", now);
    expect(windowDecision(minor, null)).toEqual({ run: false, reason: "1.5.0 wartet auf Freigabe in Verwaltung → System" });
    expect(windowDecision(minor, approval)).toMatchObject({ run: true, approved: true });
    expect(windowDecision(planUpdate("1.4.0", [rel("1.5.0"), rel("1.5.1")], "stabil", now), approval)).toMatchObject({ run: false });
    expect(windowDecision(null, approval)).toMatchObject({ run: false, reason: "Updates nicht abrufbar" });
    expect(windowDecision(planUpdate("1.5.0", [rel("1.5.0")], "stabil", now), null)).toMatchObject({ run: false, reason: "aktuell" });
  });
});
