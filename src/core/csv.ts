// CSV für Tabellenprogramme (Semikolon, UTF-8 mit BOM) – gemeinsam für alle Exporte und Importe.

/**
 * Eine Zelle: gegen Formel-Injektion entschärft (Zellen, die mit =, +, -, @, Tab oder CR beginnen, bekommen ein
 * vorangestelltes Hochkomma) und bei Trennzeichen, Anführungszeichen oder Zeilenumbruch in Anführungszeichen gesetzt.
 */
export function csvCell(raw: string): string {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Ganze Datei: Zeilen mit CRLF, BOM vorweg (Umlaute in Tabellenprogrammen). */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return "﻿" + rows.map((r) => r.map((c) => csvCell(c === null || c === undefined ? "" : String(c))).join(";")).join("\r\n") + "\r\n";
}

export const CSV_ENCODINGS = ["utf8", "cp1252"] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];

/** Windows-1252 im Bereich 0x80–0x9F (sonst deckungsgleich mit Latin-1). */
const CP1252_HIGH: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/**
 * Text nach Windows-1252 (ältere Schulverwaltungsprogramme erwarten das). Zeichen ohne Entsprechung werden zu „?“.
 * Ein UTF-8-BOM am Anfang fällt weg.
 */
export function encodeCp1252(text: string): Uint8Array {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const out: number[] = [];
  for (const ch of src) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else out.push(CP1252_HIGH[ch] ?? 0x3f);
  }
  return Uint8Array.from(out);
}

/** CSV-Datei in der gewählten Kodierung: UTF-8 mit BOM oder Windows-1252 ohne BOM. */
export function csvBytes(rows: readonly (readonly (string | number | null | undefined)[])[], encoding: CsvEncoding): Uint8Array {
  const text = toCsv(rows);
  return encoding === "cp1252" ? encodeCp1252(text) : new TextEncoder().encode(text);
}

/** Zerlegt eine CSV-Zeile mit Anführungszeichen-Unterstützung. */
export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Trennzeichen der ersten nichtleeren Zeile: „;“ oder „,“. */
export function detectSeparator(text: string): ";" | "," {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : ",";
}
