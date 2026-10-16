import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AFTER_FILE } from "./abschluss";
import { finishAtConsole } from "./abschluss-konsole";

// GATE-4f C-12: der echte Abschluss (readline, closableAsk, Block 8, Frage, Datei „danach“) mit Ersatz-Terminal
const KEY = "cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-jklnrtuv-cbdefghi-ttttvvvv";

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { columns: number; rows: number };
  output.columns = 80;
  output.rows = 40;
  let screen = "";
  output.on("data", (b: Buffer) => (screen += b.toString("utf8")));
  /** wartet, bis `text` auf dem Bildschirm steht, und tippt dann `line` + Enter */
  const type = async (text: string, line: string) => {
    for (let i = 0; i < 200 && !screen.includes(text); i++) await new Promise((r) => setTimeout(r, 5));
    expect(screen).toContain(text);
    screen = "";
    input.write(`${line}\n`);
  };
  return { io: { input, output }, input, type, screen: () => screen };
}

describe("Abschluss an der Konsole (INST-05, GATE-4f C-12)", () => {
  let dir: string;
  let hung: boolean;
  const hang = () => {
    hung = true;
    return new Promise<never>(() => {});
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "abschluss-"));
    hung = false;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("Startreihenfolge vor der Bestätigung; falscher Block wird abgelehnt, Block 8 bestätigt, „a“ schaltet aus", async () => {
    const t = terminal();
    const calls: string[] = [];
    const done = finishAtConsole(KEY, null, dir, "test", t.io, {
      bootOrder: () => {
        calls.push("boot");
        return { ok: true, order: ["0003"] };
      },
      hang,
    });
    await t.type("Tippe Block 8 des Wiederherstellungsschlüssels ein", "cbdefghi");
    expect(calls).toEqual(["boot"]);
    expect(existsSync(path.join(dir, AFTER_FILE))).toBe(false);
    await t.type("Das war nicht Block 8", "TTTT-vvvv");
    await t.type("Enter = Neustart", "a");
    expect(await done).toBe("aus");
    expect(readFileSync(path.join(dir, AFTER_FILE), "utf8")).toBe("aus\n");
  });

  it("INST-06: eigener SCHULOSCFG-Stick wird vor dem Hinweis „JETZT abziehen“ ausgehängt, auf dem Medium nicht", async () => {
    for (const where of ["stick", "medium"] as const) {
      const t = terminal();
      let released = 0;
      const done = finishAtConsole(KEY, null, dir, "test", t.io, {
        bootOrder: () => ({ ok: true, order: [] }),
        hang,
        configLocation: where,
        releaseStick: () => released++,
      });
      await t.type("Tippe Block 8 des Wiederherstellungsschlüssels ein", "ttttvvvv");
      await t.type(where === "stick" ? "Konfigurations-Stick (SCHULOSCFG) JETZT abziehen" : "liegt auf dem Installationsmedium", "");
      expect(await done).toBe("neustart");
      expect(released).toBe(where === "stick" ? 1 : 0);
    }
  });

  it("ohne Startreihenfolge: Enter schaltet aus (nicht ins Medium neu starten)", async () => {
    const t = terminal();
    const done = finishAtConsole(KEY, "ABCD-EFGH-JKLM", dir, "test", t.io, { bootOrder: () => ({ ok: false, reason: "kein UEFI" }), hang });
    await t.type("Tippe Block 8 des Wiederherstellungsschlüssels ein", "ttttvvvv");
    await t.type("Enter = ausschalten", "");
    expect(await done).toBe("aus");
  });

  it("Eingabe endet (EOF) vor Block 8: keine Bestätigung, keine Datei „danach“, kein Weiterlaufen", async () => {
    const t = terminal();
    void finishAtConsole(KEY, null, dir, "test", t.io, { bootOrder: () => ({ ok: true, order: [] }), hang });
    for (let i = 0; i < 200 && !t.screen().includes("Tippe Block 8 des Wiederherstellungsschlüssels ein"); i++) await new Promise((r) => setTimeout(r, 5));
    t.input.end();
    for (let i = 0; i < 200 && !hung; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hung).toBe(true);
    expect(t.screen()).toContain("Es wird nicht automatisch neu gestartet");
    expect(existsSync(path.join(dir, AFTER_FILE))).toBe(false);
  });

  it("EOF nach der Bestätigung, aber vor der Entscheidung: ebenfalls keine Datei „danach“", async () => {
    const t = terminal();
    void finishAtConsole(KEY, null, dir, "test", t.io, { bootOrder: () => ({ ok: true, order: [] }), hang });
    await t.type("Tippe Block 8 des Wiederherstellungsschlüssels ein", "ttttvvvv");
    for (let i = 0; i < 200 && !t.screen().includes("Enter = Neustart"); i++) await new Promise((r) => setTimeout(r, 5));
    t.input.end();
    for (let i = 0; i < 200 && !hung; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hung).toBe(true);
    expect(existsSync(path.join(dir, AFTER_FILE))).toBe(false);
  });

  it("ohne Terminal: wartet, statt zu bestätigen", async () => {
    const log: string[] = [];
    void finishAtConsole(KEY, null, dir, "test", null, { bootOrder: () => ({ ok: true, order: [] }), hang, log: (x) => log.push(x) });
    expect(hung).toBe(true);
    expect(log.join("")).toContain("es wird nicht neu gestartet");
    expect(existsSync(path.join(dir, AFTER_FILE))).toBe(false);
  });
});
