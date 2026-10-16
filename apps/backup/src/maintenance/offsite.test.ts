import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "@schulos/server/exec";
import { offsiteConfig, offsiteCopy } from "./offsite";

const snap = (id: string, time: string) => ({ id: id.repeat(8), short_id: id.repeat(8).slice(0, 8), time, hostname: "agent", tags: [] });

function fakeExec(opts: { offsite: ReturnType<typeof snap>[][]; local?: ReturnType<typeof snap>[]; rcloneFails?: boolean }) {
  const calls: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  let offsiteRead = 0;
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, env: o?.env });
    if (cmd === "rclone") return opts.rcloneFails ? { code: 1, stdout: "", stderr: "Failed to copy: dial tcp: connection refused" } : { code: 0, stdout: "", stderr: "" };
    if (args[0] === "snapshots") {
      const offsite = o?.env?.RESTIC_REPOSITORY?.startsWith("rclone:");
      const list = offsite ? (opts.offsite[Math.min(offsiteRead++, opts.offsite.length - 1)] ?? []) : (opts.local ?? [snap("a", "2026-10-05T00:00:00Z")]);
      return { code: 0, stdout: JSON.stringify(list), stderr: "" };
    }
    if (args[0] === "forget") return { code: 0, stdout: JSON.stringify([{ keep: [1, 2], remove: [3] }]), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const ctx = (exec: Exec) => ({ exec, bin: "restic", restDir: "/srv/rest", rclone: "rclone" });
const retention = { daily: 14, weekly: 8, monthly: 12 };

describe("Offsite-Kopie", () => {
  it("Ziel aus SCHULOS_OFFSITE, ohne Angabe keine Kopie, Unsinn abgelehnt", () => {
    expect(offsiteConfig({})).toBeNull();
    expect(offsiteConfig({ SCHULOS_OFFSITE: "storagebox:schulos/" })).toEqual({ base: "storagebox:schulos" });
    expect(() => offsiteConfig({ SCHULOS_OFFSITE: "/lokal/pfad" })).toThrow("rclone-Ziel");
    expect(() => offsiteConfig({ SCHULOS_OFFSITE: "x:$(rm -rf /)" })).toThrow();
  });

  it("Schlüssel 1:1, dann restic copy mit gleichem Passwort, dann gleiche Aufbewahrung", async () => {
    const f = fakeExec({ offsite: [[snap("o", "2026-10-03T00:00:00Z")], [snap("a", "2026-10-05T00:00:00Z"), snap("o", "2026-10-03T00:00:00Z")]] });
    const r = await offsiteCopy(ctx(f.exec), { base: "storagebox:schulos" }, "i-ab12", "repo-pw", retention);
    expect(r).toEqual({ stand: "aaaaaaaa", staende: 2, kopiert: 1, entfernt: 1 });
    const src = path.join("/srv/rest", "i-ab12");
    expect(f.calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["restic snapshots", "rclone copy", "rclone copy", "restic snapshots", "restic copy", "restic forget", "restic snapshots"]);
    expect(f.calls[1]!.args).toEqual(["copy", path.join(src, "config"), "storagebox:schulos/i-ab12"]);
    expect(f.calls[2]!.args).toEqual(["copy", path.join(src, "keys"), "storagebox:schulos/i-ab12/keys"]);
    expect(f.calls[4]!.args).toEqual(["copy", "--retry-lock", "10m", "--from-repo", src]);
    expect(f.calls[4]!.env).toEqual({ RESTIC_REPOSITORY: "rclone:storagebox:schulos/i-ab12", RESTIC_PASSWORD: "repo-pw", RESTIC_FROM_PASSWORD: "repo-pw" });
    expect(f.calls[5]!.args).toEqual(expect.arrayContaining(["--keep-daily", "14", "--keep-weekly", "8", "--keep-monthly", "12"]));
    expect(f.calls[5]!.env?.RESTIC_REPOSITORY).toBe("rclone:storagebox:schulos/i-ab12");
  });

  it("ohne Sicherung nichts zu tun; Ziel nicht erreichbar → verständlicher Fehler", async () => {
    await expect(offsiteCopy(ctx(fakeExec({ offsite: [[]], local: [] }).exec), { base: "x:y" }, "i", "pw", retention)).rejects.toThrow("Noch keine Sicherung");
    await expect(offsiteCopy(ctx(fakeExec({ offsite: [[]], rcloneFails: true }).exec), { base: "x:y" }, "i", "pw", retention)).rejects.toThrow(
      "Offsite-Ziel nicht erreichbar: Failed to copy: dial tcp: connection refused",
    );
  });
});
