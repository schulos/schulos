import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSteps, StepError } from "./run";
import type { Step } from "./steps";

const node = (code: string): string[] => [process.execPath, "-e", code];

describe("Ausführer der Systemschritte", () => {
  it("Befehle mit und ohne Eingabe, Dateien, Wiederherstellungsschlüssel; Protokoll ohne Geheimnisse; Aufräumen läuft immer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-run-"));
    const log = path.join(dir, "log", "installation.log");
    const seen: string[] = [];
    const steps: Step[] = [
      // beendet sich sofort, ohne stdin zu lesen – früher EPIPE-Absturz, wenn trotzdem geschrieben wurde
      ...Array.from({ length: 20 }, (): Step => ({ kind: "run", title: "schnell", argv: node("process.exit(0)") })),
      { kind: "run", title: "liest Passphrase", argv: node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(s.length===10?0:3))"), stdin: "geheim-123" },
      { kind: "write", title: "Datei", path: path.join(dir, "ziel", "etc", "hostname"), content: "schulos\n", mode: 0o644 },
      {
        kind: "run",
        title: "Schlüssel",
        // Schlüssel erst zur Laufzeit zusammensetzen – argv steht im Protokoll, die Ausgabe darf es nicht
        argv: node("console.log('Schlüssel: ' + ['fvhkbbdg','nnctbgrl','jtrgtvif','ceubtfcb','dlgbvdec','ckdhbgnh','hcteduvg','knnvcrtj'].join('-'))"),
        capture: "recoveryKey",
      },
    ];
    const cleanup: Step[] = [{ kind: "run", title: "aufräumen", argv: node("process.exit(1)"), allowFail: true }];
    const r = await runSteps(steps, cleanup, { log, onStep: (_i, _n, s) => seen.push(s.title) });
    expect(r.recoveryKey).toBe("fvhkbbdg-nnctbgrl-jtrgtvif-ceubtfcb-dlgbvdec-ckdhbgnh-hcteduvg-knnvcrtj");
    expect(seen).toHaveLength(steps.length);
    expect(readFileSync(path.join(dir, "ziel", "etc", "hostname"), "utf8")).toBe("schulos\n");
    const text = readFileSync(log, "utf8");
    expect(text).toContain("(Eingabe verborgen)");
    expect(text).not.toContain("geheim-123");
    expect(text).not.toContain("fvhkbbdg-nnctbgrl");
    rmSync(dir, { recursive: true, force: true });
  });

  it("Fehler bricht ab (letzte Zeile der Fehlerausgabe), Aufräumen läuft trotzdem; ohne Schlüssel in der Ausgabe kein TPM-only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "schulos-run-"));
    const log = path.join(dir, "installation.log");
    const marker = path.join(dir, "aufgeraeumt");
    const cleanup: Step[] = [{ kind: "write", title: "aufräumen", path: marker, content: "ja", mode: 0o644 }];
    const fail: Step = { kind: "run", title: "mkfs", argv: node("console.error('erste');console.error('mkfs: Gerät belegt');process.exit(2)") };
    await expect(runSteps([fail], cleanup, { log })).rejects.toThrow(new StepError(fail, "mkfs: mkfs: Gerät belegt"));
    expect(readFileSync(marker, "utf8")).toBe("ja");
    const noKey: Step = { kind: "run", title: "Wiederherstellungsschlüssel", argv: node("console.log('nichts')"), capture: "recoveryKey" };
    await expect(runSteps([noKey], [], { log })).rejects.toThrow(/kein Schlüssel/);
    rmSync(dir, { recursive: true, force: true });
  });
});
