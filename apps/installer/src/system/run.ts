// Führt die Systemschritte aus (als root im Live-System). Protokoll ohne Eingaben (Passphrase, Passwort) und ohne
// gemerkte Ausgaben; bei einem Fehler laufen die Aufräumschritte, dann bricht die Installation ab.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractRecoveryKey } from "@schulos/server/recovery-key";
import type { Step } from "./steps";

export interface RunResult {
  /** LUKS-Wiederherstellungsschlüssel (TPM2) – einmal anzeigen, nirgends speichern */
  recoveryKey: string | null;
}

export class StepError extends Error {
  constructor(
    readonly step: Step,
    message: string,
  ) {
    super(message);
  }
}

export { extractRecoveryKey };

function exec(argv: string[], stdin: string | undefined): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // stdin nur mit Eingabe öffnen: liest ein Befehl sie nicht und ist schon fertig, gäbe das Schreiben EPIPE (Absturz, CI)
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, DEBIAN_FRONTEND: "noninteractive", LC_ALL: "C" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      child.stdin.on("error", () => {}); // Befehl hat die Eingabe nicht gelesen – sein Exitcode entscheidet
      child.stdin.end(stdin);
    }
  });
}

export interface RunOptions {
  log: string;
  onStep?: (index: number, total: number, step: Step) => void;
}

export async function runSteps(steps: Step[], cleanup: Step[], o: RunOptions): Promise<RunResult> {
  mkdirSync(path.dirname(o.log), { recursive: true });
  const log = (line: string) => appendFileSync(o.log, `${new Date().toISOString()} ${line}\n`);
  const result: RunResult = { recoveryKey: null };
  const one = async (step: Step): Promise<void> => {
    if (step.kind === "write") {
      log(`schreibe ${step.path}`);
      mkdirSync(path.dirname(step.path), { recursive: true });
      writeFileSync(step.path, step.content, { mode: step.mode });
      chmodSync(step.path, step.mode);
      return;
    }
    log(`$ ${step.argv.join(" ")}${step.stdin !== undefined ? " (Eingabe verborgen)" : ""}`);
    const r = await exec(step.argv, step.stdin);
    // gemerkte Ausgaben (Wiederherstellungsschlüssel) nie ins Protokoll – auch nicht über stderr
    if (step.capture !== "recoveryKey") {
      log(r.stdout.trimEnd());
      log(r.stderr.trimEnd());
    }
    if (r.code !== 0 && !step.allowFail) throw new StepError(step, `${step.title}: ${r.stderr.trim().split("\n").pop() || `Exit ${r.code}`}`);
    if (step.capture === "recoveryKey") {
      result.recoveryKey = extractRecoveryKey(r.stdout) ?? extractRecoveryKey(r.stderr);
      // ohne Wiederherstellungsschlüssel hinge die Platte allein am TPM – lieber abbrechen
      if (!result.recoveryKey) throw new StepError(step, `${step.title}: kein Schlüssel in der Ausgabe`);
    }
  };
  try {
    for (const [i, step] of steps.entries()) {
      o.onStep?.(i, steps.length, step);
      await one(step);
    }
    return result;
  } finally {
    for (const step of cleanup) await one(step).catch(() => {});
  }
}
