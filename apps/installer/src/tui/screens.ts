// Bildschirme nach der Installation als Zeilen (INST-01-Abschluss läuft über readline, nicht Ink): Titelleiste über dem
// Wiederherstellungsschlüssel und ein Rahmen mit Logo um den Abschlussbildschirm (INST-02). Rein; nur Aussehen – Inhalt,
// Ablauf und Eingaben bleiben in recovery-key.ts/abschluss.ts.
import type { Theme } from "./theme";

const BOXES = {
  round: ["╭", "╮", "╰", "╯", "─", "│"],
  single: ["┌", "┐", "└", "┘", "─", "│"],
  classic: ["+", "+", "+", "+", "-", "|"],
} as const;

// sichtbare Breite ohne Farb-Steuerzeichen
const visible = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

/** Zeile auf `width` umbrechen (an Leerzeichen, Einrückung bleibt) */
export function wrapLine(line: string, width: number): string[] {
  if (visible(line) <= width) return [line];
  const indent = /^ */.exec(line)![0];
  const out: string[] = [];
  let cur = indent;
  for (const word of line.trim().split(/ +/)) {
    if (cur.trim() && visible(cur) + 1 + visible(word) > width) {
      out.push(cur);
      cur = indent;
    }
    cur += (cur.trim() ? " " : "") + word;
  }
  out.push(cur);
  return out;
}

/** aufeinanderfolgende Zeilen (für 80 Spalten von Hand umbrochen) zu Absätzen zusammenfassen; Leerzeilen bleiben */
export function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let prev = "";
  for (const l of lines) {
    if (l.trim() && prev.trim()) out[out.length - 1] += ` ${l.trim()}`;
    else out.push(l);
    prev = l;
  }
  return out;
}

function sgr(theme: Theme, color: boolean, codes: string, text: string) {
  return color && theme.charset !== "ascii" ? `\x1b[${codes}m${text}\x1b[0m` : text;
}

/** Eine Zeile: „SchulOS-Installer · <titel>“ links, Version rechts – invers in der Akzentfarbe */
export function titleBar(theme: Theme, width: number, title: string, version: string, color = true): string {
  const left = ` SchulOS-Installer ${theme.g.sep} ${title}`;
  const right = `Version ${version} `;
  const gap = Math.max(1, width - visible(left) - visible(right));
  return sgr(theme, color, "1;7;36", left + " ".repeat(gap) + right);
}

/** Rahmen mit Logo und Version um `lines` (Abschlussbildschirm); `width` = Bildschirmbreite */
export function framed(theme: Theme, width: number, title: string, version: string, lines: string[], color = true): string[] {
  const w = Math.max(40, Math.min(width, 100));
  const inner = w - 4;
  const [tl, tr, bl, br, h, v] = BOXES[theme.g.border === "round" ? "round" : theme.g.border === "single" ? "single" : "classic"];
  const edge = (s: string) => sgr(theme, color, "36", s);
  const row = (s: string) => `${edge(v)} ${pad(s, inner)} ${edge(v)}`;
  const logo = theme.g.logo.map((l, i) => {
    const right = i === 0 ? title : `Version ${version}`;
    return row(sgr(theme, color, "1;36", l) + " ".repeat(Math.max(1, inner - visible(l) - visible(right))) + (i === 0 ? sgr(theme, color, "1", right) : right));
  });
  if (theme.g.logo.length === 1) logo.push(row(" ".repeat(Math.max(0, inner - visible(`Version ${version}`))) + `Version ${version}`));
  const body = paragraphs(lines.map((l) => l.replace(/^ {2}/, "")))
    .flatMap((l) => wrapLine(l, inner))
    .map(row);
  return [edge(tl + h.repeat(w - 2) + tr), ...logo, row(sgr(theme, color, "2", h.repeat(inner))), ...body, edge(bl + h.repeat(w - 2) + br)];
}
