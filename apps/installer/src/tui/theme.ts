// Aussehen der Text-Oberfläche (INST-02): Zeichen und Farben je Terminal. Drei Stufen:
// · „unicode“ – gewöhnliche Terminals (SSH, Entwicklung): runde Rahmen, ✔ ▶, Akzent in der SchulOS-Farbe (packages/ui theme.css)
// · „konsole“ – Linux-Konsole (TERM=linux, Live-System): nur Zeichen, die sowohl die SchulOS-Konsolenschrift
//   (system/console-font.ts) als auch die eingebaute CP437-Schrift des Kernels haben, und die 8 Grundfarben
// · „ascii“  – kein UTF-8: nur ASCII
import type { BoxProps } from "ink";

export type Charset = "unicode" | "konsole" | "ascii";

export function detectCharset(env: Record<string, string | undefined>, platform: string = process.platform): Charset {
  const forced = env.SCHULOS_TUI_ZEICHEN;
  if (forced === "unicode" || forced === "konsole" || forced === "ascii") return forced;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (env.TERM === "dumb") return "ascii";
  if (!/utf-?8/i.test(locale) && !(locale === "" && platform === "win32")) return "ascii";
  if (env.TERM === "linux") return "konsole";
  return "unicode";
}

export interface Glyphs {
  done: string;
  current: string;
  open: string;
  /** Auswahlzeiger in Listen und Eingabefeldern */
  cursor: string;
  bar: string;
  barEmpty: string;
  mask: string;
  more: { up: string; down: string };
  ok: string;
  fail: string;
  sep: string;
  /** Pfeiltasten in den Tastenhinweisen */
  arrows: string;
  hr: string;
  border: BoxProps["borderStyle"];
  /** zwei Zeilen Logo oder eine */
  logo: string[];
}

// Halbblock-Schrift, 4 „Pixel“ hoch: S c h u l O S
const BLOCK_LOGO = ["█▀▀ ▄▄▄ █▄▄ ▄ ▄ █ █▀█ █▀▀", "▄▄█ █▄▄ █ █ █▄█ █ █▄█ ▄▄█"];

export const GLYPHS: Record<Charset, Glyphs> = {
  unicode: {
    done: "✔",
    current: "▶",
    open: "·",
    cursor: "›",
    bar: "█",
    barEmpty: "░",
    mask: "•",
    more: { up: "▲", down: "▼" },
    ok: "✔",
    fail: "✘",
    sep: "·",
    arrows: "↑↓",
    hr: "─",
    border: "round",
    logo: BLOCK_LOGO,
  },
  // CP437 ∩ SchulOS-Terminus: √ ► · » █ ░ • ▲ ▼ ┌─┐│└┘ ▀ ▄
  konsole: {
    done: "√",
    current: "►",
    open: "·",
    cursor: "»",
    bar: "█",
    barEmpty: "░",
    mask: "•",
    more: { up: "▲", down: "▼" },
    ok: "√",
    fail: "x",
    sep: "·",
    arrows: "↑↓",
    hr: "─",
    border: "single",
    logo: BLOCK_LOGO,
  },
  ascii: {
    done: "+",
    current: ">",
    open: "-",
    cursor: ">",
    bar: "#",
    barEmpty: ".",
    mask: "*",
    more: { up: "^", down: "v" },
    ok: "+",
    fail: "x",
    sep: "|",
    arrows: "Pfeile",
    hr: "-",
    border: "classic",
    logo: ["SchulOS"],
  },
};

export interface Colors {
  accent: string;
  ok: string;
  warn: string;
  danger: string;
}

// Akzent: --school #0e7c66 im dunklen Thema (80 % + Weiß) – auf dunklem Terminalgrund lesbar; Warnung/Gefahr ebenso aus theme.css
const TRUE_COLORS: Colors = { accent: "#3e9685", ok: "#4caf7a", warn: "#ffb380", danger: "#ff8f8f" };
// Linux-Konsole: nur die 8 Grundfarben (Türkis kommt der Schulfarbe am nächsten)
const BASIC_COLORS: Colors = { accent: "cyan", ok: "green", warn: "yellow", danger: "red" };

export interface Theme {
  charset: Charset;
  g: Glyphs;
  c: Colors;
}

export function themeFor(charset: Charset): Theme {
  return { charset, g: GLYPHS[charset], c: charset === "unicode" ? TRUE_COLORS : BASIC_COLORS };
}

/** Fortschrittsbalken aus Zeichen: `done` von `total`, `width` Zeichen breit */
export function bar(g: Glyphs, done: number, total: number, width: number): string {
  const n = total > 0 ? Math.round((Math.min(done, total) / total) * width) : 0;
  return g.bar.repeat(n) + g.barEmpty.repeat(width - n);
}

/** „3:07“ bzw. „1:02:05“ */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
