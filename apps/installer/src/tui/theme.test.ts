import { describe, expect, it } from "vitest";
import { QUESTIONS } from "../questions";
import { sectionOf, sections, SUMMARY, INSTALL, windowAround } from "./sections";
import { bar, detectCharset, elapsed, GLYPHS } from "./theme";
import { CTX, PRODUCTION } from "../fixtures";

// Kernel-Schrift ohne console-setup (VGA, Codepage 437)
const CP437 =
  "☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂" +
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■";
// SchulOS-Konsolenschrift (Uni2-TerminusBold + console-font.ts), geprüft gegen console-setup-linux 1.242~deb13u1 (trixie)
const SCHULOS_FONT_SYMBOLS = "↑↓▀▄▌▐▓█░▒►◄▶◀√·•»─│┌┐└┘├┤╭╮╰╯▲▼„“–›…×✗✘■●";

const chars = (g: (typeof GLYPHS)[keyof typeof GLYPHS]) =>
  new Set([g.done, g.current, g.open, g.cursor, g.bar, g.barEmpty, g.mask, g.more.up, g.more.down, g.ok, g.fail, g.sep, g.hr, g.arrows, ...g.logo].join("").replace(/[ A-Za-z]/g, ""));

describe("Zeichensatz", () => {
  it("erkennt Linux-Konsole, UTF-8-Terminal und ASCII", () => {
    expect(detectCharset({ TERM: "linux", LANG: "C.UTF-8" }, "linux")).toBe("konsole");
    expect(detectCharset({ TERM: "xterm-256color", LANG: "de_DE.UTF-8" }, "linux")).toBe("unicode");
    expect(detectCharset({ TERM: "xterm", LC_ALL: "de_DE.utf8" }, "linux")).toBe("unicode");
    expect(detectCharset({ TERM: "linux", LANG: "C" }, "linux")).toBe("ascii");
    expect(detectCharset({ TERM: "dumb", LANG: "C.UTF-8" }, "linux")).toBe("ascii");
    expect(detectCharset({}, "linux")).toBe("ascii");
    expect(detectCharset({}, "win32")).toBe("unicode");
    expect(detectCharset({ TERM: "xterm", LANG: "C.UTF-8", SCHULOS_TUI_ZEICHEN: "konsole" }, "linux")).toBe("konsole");
  });

  it("Konsole: nur Zeichen, die die SchulOS-Schrift und die CP437-Schrift des Kernels beide haben", () => {
    for (const ch of chars(GLYPHS.konsole)) {
      expect(CP437, ch).toContain(ch);
      expect(SCHULOS_FONT_SYMBOLS, ch).toContain(ch);
    }
    // Rahmen „single“: ┌─┐│└┘
    for (const ch of "┌─┐│└┘") expect(CP437).toContain(ch);
    expect(GLYPHS.konsole.border).toBe("single");
  });

  it("ASCII: nur 7-Bit-Zeichen", () => {
    for (const ch of chars(GLYPHS.ascii)) expect(ch.charCodeAt(0), ch).toBeLessThan(0x80);
    expect(GLYPHS.ascii.border).toBe("classic");
  });

  it("Balken und Zeit", () => {
    expect(bar(GLYPHS.ascii, 1, 4, 8)).toBe("##......");
    expect(bar(GLYPHS.unicode, 0, 0, 3)).toBe("░░░");
    expect(bar(GLYPHS.unicode, 9, 4, 3)).toBe("███");
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(187_400)).toBe("3:07");
    expect(elapsed(3_725_000)).toBe("1:02:05");
  });
});

describe("Schrittleiste", () => {
  it("jede Frage gehört zu einem Abschnitt", () => {
    for (const q of QUESTIONS) expect(() => sectionOf(q.id)).not.toThrow();
  });

  it("erledigt / aktuell / offen je Position", () => {
    const at = sections(PRODUCTION, CTX, { questionId: "network.hostname" });
    const titles = at.map((s) => s.title);
    expect(titles.slice(0, 4)).toEqual(["Sprache & Region", "Rolle", "Platte", "Netzwerk"]);
    expect(titles).toContain("Schule");
    expect(titles.slice(-2)).toEqual([SUMMARY, INSTALL]);
    expect(at.slice(0, 3).every((s) => s.state === "done")).toBe(true);
    expect(at[3]).toEqual({ title: "Netzwerk", state: "current" });
    expect(at.slice(4).every((s) => s.state === "open")).toBe(true);
    const sum = sections(PRODUCTION, CTX, "summary");
    expect(sum.filter((s) => s.state === "current").map((s) => s.title)).toEqual([SUMMARY]);
    expect(sections(PRODUCTION, CTX, "install").at(-1)!.state).toBe("current");
    expect(sections(PRODUCTION, CTX, "finished").every((s) => s.state === "done")).toBe(true);
    // Backupserver: keine Schule, keine Offsite-Pflicht – nur die Abschnitte seiner Fragen
    expect(sections({ role: "backup" }, CTX, "summary").map((s) => s.title)).not.toContain("Schule");
  });

  it("Ausschnitt um die Auswahl", () => {
    expect(windowAround(5, 4, 10)).toEqual({ start: 0, end: 5 });
    expect(windowAround(16, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(windowAround(16, 8, 5)).toEqual({ start: 6, end: 11 });
    expect(windowAround(16, 15, 5)).toEqual({ start: 11, end: 16 });
  });
});
