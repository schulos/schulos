import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => Promise<ExecResult>;

/** Startet ein Programm ohne Shell (keine Quoting-Fallen) und sammelt die Ausgaben. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Aussagekräftige Zeile einer Fehlerausgabe (restic: „Fatal: …“, sonst die letzte), gekürzt – für Meldungen an den Backupserver. */
export function lastLine(text: string, max = 300): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.findLast((l) => l.startsWith("Fatal:")) ?? lines.at(-1);
  return (line ?? "unbekannter Fehler").slice(0, max);
}
