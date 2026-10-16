import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { checkConfirmation, closableAsk, CONFIRM_PROMPT, confirmRecoveryKey, InputClosedError, extractRecoveryKey, keyBlocks, recoveryKeyScreen } from "./recovery-key";

const KEY = "fvhkbbdg-nnctbgrl-jtrgtvif-ceubtfcb-dlgbvdec-ckdhbgnh-hcteduvg-knnvcrtj";
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("Wiederherstellungsschlüssel (INST-01)", () => {
  it("findet den Schlüssel in der Ausgabe von systemd-cryptenroll", () => {
    expect(extractRecoveryKey(`A secret recovery key has been generated:\n\n    🔐 ${KEY}\n`)).toBe(KEY);
    expect(extractRecoveryKey("nichts")).toBeNull();
  });

  it("teilt in 8 Blöcke", () => {
    expect(keyBlocks(KEY)).toHaveLength(8);
    expect(keyBlocks(KEY)[7]).toBe("knnvcrtj");
  });

  it("Bestätigung: letzter Block oder ganzer Schlüssel, unabhängig von Schreibweise; leer = erneut anzeigen", () => {
    expect(checkConfirmation(KEY, "knnvcrtj")).toBe("ok");
    expect(checkConfirmation(KEY, "  KNNV CRTJ ")).toBe("ok");
    expect(checkConfirmation(KEY, KEY.toUpperCase())).toBe("ok");
    expect(checkConfirmation(KEY, "")).toBe("anzeigen");
    expect(checkConfirmation(KEY, "   ")).toBe("anzeigen");
    expect(checkConfirmation(KEY, "hcteduvg")).toBe("falsch");
    expect(checkConfirmation(KEY, "knnvcrt")).toBe("falsch");
  });

  it("Bildschirm nur mit Text (INST-05, kein QR-Code): passt in 80×25, alle Blöcke nummeriert, keine Blockzeichen", () => {
    const lines = recoveryKeyScreen(KEY);
    expect(lines.length).toBeLessThanOrEqual(22); // + Titelleiste + Hinweis + Eingabezeile
    for (const l of lines) expect(plain(l).length).toBeLessThanOrEqual(80);
    const text = lines.map(plain).join("\n");
    keyBlocks(KEY).forEach((b, i) => expect(text).toMatch(new RegExp(`${i + 1}   ${b}`)));
    expect(text).toContain(KEY);
    // keine Block-/Halbblockzeichen mehr (die Konsolenschrift zeigte ◆ statt ▀ ▄)
    expect(text).not.toMatch(/[▀▄█]/);
    expect(text).not.toContain("QR");
  });

  it("fragt ohne Zeitlimit, bis Block 8 stimmt – falsch → Hinweis, leer → erneut anzeigen", async () => {
    const answers = ["", "falsch", "knnvcrtj"];
    const shown: string[][] = [];
    await confirmRecoveryKey(KEY, { show: (l) => shown.push(l.map(plain)), ask: async () => answers.shift()! });
    expect(shown).toHaveLength(3);
    expect(shown[1]!.join("\n")).not.toContain("nicht Block 8");
    expect(shown[2]!.join("\n")).toContain("nicht Block 8");
    expect(answers).toHaveLength(0);
  });

  it("INST-09: Abfrage als Aufforderung, Hinweis und Eingabe passen in 80 Spalten", async () => {
    const asked: string[] = [];
    const shown: string[][] = [];
    const answers = ["falsch", "knnvcrtj"];
    await confirmRecoveryKey(KEY, { show: (l) => shown.push(l.map(plain)), ask: async (p) => (asked.push(p), answers.shift()!) });
    expect(asked[0]).toBe(CONFIRM_PROMPT);
    expect(CONFIRM_PROMPT).toContain("Tippe Block 8 des Wiederherstellungsschlüssels ein");
    // Platz für die 8 Zeichen der Eingabe in derselben Zeile
    expect(CONFIRM_PROMPT.length + 8).toBeLessThanOrEqual(80);
    for (const l of shown[1]!) expect(l.length).toBeLessThanOrEqual(80);
    expect(shown[1]!.at(-1)).toContain("Enter ohne Eingabe");
  });
});

describe("Bestätigung ohne Eingabe (INST-05)", () => {
  // Befund Hyper-V 0.3.2: nichts eingetippt, trotzdem ging es weiter – EOF/geschlossene Eingabe darf nie bestätigen
  it("EOF vor der Antwort: Bestätigung scheitert mit InputClosedError, nichts gilt als bestätigt", async () => {
    const input = new PassThrough();
    const ref = vi.fn();
    Object.assign(input, { ref });
    const rl = createInterface({ input, output: new PassThrough(), terminal: false });
    const ask = closableAsk(rl, input);
    expect(ref).toHaveBeenCalled();
    const shown: string[][] = [];
    const done = confirmRecoveryKey(KEY, { show: (l) => shown.push(l), ask });
    input.end();
    await expect(done).rejects.toBeInstanceOf(InputClosedError);
    expect(shown).toHaveLength(1);
    // auch spätere Fragen scheitern sofort
    await expect(ask("noch was? ")).rejects.toBeInstanceOf(InputClosedError);
  });

  it("leere Zeilen und falsche Blöcke vor EOF bestätigen ebenfalls nicht", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough(), terminal: false });
    const done = confirmRecoveryKey(KEY, { show: () => {}, ask: closableAsk(rl, input) });
    input.write("\n");
    input.write("hcteduvg\n");
    input.end();
    await expect(done).rejects.toBeInstanceOf(InputClosedError);
  });

  it("mit Eingabe: Block 8 bestätigt", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough(), terminal: false });
    const done = confirmRecoveryKey(KEY, { show: () => {}, ask: closableAsk(rl, input) });
    input.write("knnvcrtj\n");
    await expect(done).resolves.toBeUndefined();
    rl.close();
  });
});

describe("Ink-Nachwirkung: stdin.unref() (INST-05, Ursache des Befunds)", () => {
  // Ink 8 ruft beim Verlassen der Oberfläche `stdin.unref()`. Ohne `ref` endet Node während der offenen Frage mit Code 0 –
  // genau das war „nichts eingetippt, trotzdem Fertig“. Nachgestellt in einem Kindprozess mit Pipe als stdin.
  const MODULE = pathToFileURL(path.join(import.meta.dirname, "recovery-key.ts")).href;
  const child = (useClosableAsk: boolean) =>
    spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createInterface } from "node:readline/promises";
         const { closableAsk, confirmRecoveryKey } = await import(${JSON.stringify(MODULE)});
         process.stdin.resume(); process.stdin.unref(); // wie Ink beim Unmount
         const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
         const ask = ${useClosableAsk} ? closableAsk(rl, process.stdin) : (p) => rl.question(p);
         // wie main().catch(…) im Installer: kein Top-Level-await, der Prozess endet, wenn nichts ihn hält
         confirmRecoveryKey(${JSON.stringify(KEY)}, { show: () => {}, ask }).then(() => { console.log("BESTAETIGT"); rl.close(); });`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
  const exit = (c: ReturnType<typeof spawn>) => new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
  let out = "";

  it("ohne ref: Prozess endet ohne Eingabe mit Code 0 (der Fehler)", async () => {
    const c = child(false);
    c.stdout!.on("data", (d) => (out += d));
    expect(await exit(c)).toBe(0);
    expect(out).not.toContain("BESTAETIGT");
    c.stdin!.destroy();
  });

  it("mit closableAsk: wartet auf die Eingabe und bestätigt erst mit Block 8", async () => {
    out = "";
    const c = child(true);
    c.stdout!.on("data", (d) => (out += d));
    const code = exit(c);
    const alive = await Promise.race([code.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 1500))]);
    expect(alive).toBe(true);
    c.stdin!.write("knnvcrtj\n");
    expect(await code).toBe(0);
    expect(out).toContain("BESTAETIGT");
  });
});
