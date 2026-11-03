// Losreihenfolge (gemeinsam für Kurswahl P4-63 und Losverfahren der Schulanmeldung LO-01) – rein, deterministisch,
// nachrechenbar: keine DB, keine Uhr, kein Math.random. Wer Seed und Teilnehmer-Kennungen kennt, kann die Reihenfolge mit
// jedem Werkzeug nachrechnen (docs/LOSVERFAHREN.md §4):
//   1. je Kennung k den Text „<seed>:<k>“ (UTF-16-Codeeinheiten, bei ASCII-Text = Bytes) mit FNV-1a (32 Bit) hashen,
//   2. aufsteigend nach diesem Hash sortieren, bei Gleichstand nach der Kennung (Zeichenfolge, aufsteigend).

/** FNV-1a (32 Bit) – stabiler Hash für die Losreihenfolge. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Losreihenfolge: kleinerer Hash zuerst, bei Gleichstand die ID. */
export function lotOrder(seed: string, ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => hash(`${seed}:${a}`) - hash(`${seed}:${b}`) || (a < b ? -1 : a > b ? 1 : 0));
}
