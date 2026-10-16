// Inhaltsverzeichnis eines Datenbank-Dumps prüfen, bevor er eingespielt wird (SEC-06). Dumps kommen über den Backupserver und
// sind damit nicht vertrauenswürdig: Ein Custom-Dump enthält beliebiges SQL, das pg_restore unverändert ausführt.
// Erlaubt sind nur die Arten, die das SchulOS-Schema erzeugt (Tabellen, Typen, Indizes, Constraints, Sequenzen, Kollation) –
// Funktionen, Sprachen, Trigger, Regeln, Sichten, fremde Erweiterungen usw. lehnt die Prüfung ab. pg_stat_statements
// (legt die App selbst an) und Rechte (ACL) werden übersprungen, damit auch eine Rolle ohne Superuser-Recht einspielen kann.
// Grenze: Auch in erlaubten Einträgen steht freier SQL-Text – die eigentliche Schranke ist die Rolle ohne Superuser-Recht
// (Test-Restore). Für die Wiederherstellung ins Live-System fängt die Prüfung nur grobe Fälle ab (SEC-07).

/** Arten, die das SchulOS-Schema erzeugt (drizzle/*.sql; neue Art → hier ergänzen, sonst schlagen Test-Restores fehl). */
export const ALLOWED_TOC_TYPES = [
  "SCHEMA",
  "TYPE",
  "COLLATION",
  "TABLE",
  "TABLE DATA",
  "SEQUENCE",
  "SEQUENCE SET",
  "SEQUENCE OWNED BY",
  "DEFAULT",
  "CONSTRAINT",
  "CHECK CONSTRAINT",
  "FK CONSTRAINT",
  "INDEX",
  "INDEX ATTACH",
  "COMMENT",
  "ENCODING",
  "STDSTRINGS",
  "SEARCHPATH",
] as const;

/** Bekannte Arten, die nie eingespielt werden (abgelehnt), damit die Fehlermeldung die Art nennt statt „unbekannt“. */
const KNOWN_TYPES = [
  ...ALLOWED_TOC_TYPES,
  "ACL",
  "DEFAULT ACL",
  "EXTENSION",
  "FUNCTION",
  "PROCEDURE",
  "AGGREGATE",
  "PROCEDURAL LANGUAGE",
  "LANGUAGE",
  "TRIGGER",
  "EVENT TRIGGER",
  "RULE",
  "VIEW",
  "MATERIALIZED VIEW",
  "MATERIALIZED VIEW DATA",
  "CAST",
  "OPERATOR",
  "OPERATOR CLASS",
  "OPERATOR FAMILY",
  "CONVERSION",
  "DOMAIN",
  "FOREIGN DATA WRAPPER",
  "SERVER",
  "USER MAPPING",
  "FOREIGN TABLE",
  "PUBLICATION",
  "PUBLICATION TABLE",
  "SUBSCRIPTION",
  "LARGE OBJECT",
  "BLOB",
  "BLOBS",
  "BLOB METADATA",
  "POLICY",
  "ROW SECURITY",
  "STATISTICS",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH PARSER",
  "TEXT SEARCH TEMPLATE",
  "TRANSFORM",
  "ACCESS METHOD",
  "DATABASE",
  "DATABASE PROPERTIES",
].sort((a, b) => b.length - a.length);

/** Einträge, die übersprungen (nicht eingespielt) werden: die Erweiterung der Abfragestatistik samt Kommentar, Rechte. */
function skipped(type: string, rest: string): boolean {
  if (type === "ACL" || type === "DEFAULT ACL") return true;
  if (type === "EXTENSION") return /^- pg_stat_statements\b/.test(rest);
  if (type === "COMMENT") return /^- EXTENSION pg_stat_statements\b/.test(rest);
  return false;
}

export interface TocCheck {
  /** Inhalt für `pg_restore --use-list` (übersprungene Einträge auskommentiert) */
  list: string;
  /** eingespielte Einträge */
  entries: number;
  /** abgelehnte Einträge (Art + Name) – nicht leer → Dump nicht einspielen */
  rejected: string[];
}

/** `pg_restore --list` auswerten. */
export function checkDumpToc(listing: string): TocCheck {
  const out: string[] = [];
  const rejected: string[] = [];
  let entries = 0;
  for (const line of listing.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith(";")) {
      out.push(line);
      continue;
    }
    const m = /^\d+; \d+ \d+ (.*)$/.exec(line);
    if (!m) {
      rejected.push(`unlesbare Zeile „${line.slice(0, 60)}“`);
      continue;
    }
    const body = m[1]!;
    const type = KNOWN_TYPES.find((t) => body === t || body.startsWith(`${t} `));
    const rest = type ? body.slice(type.length + 1) : body;
    if (type && skipped(type, rest)) {
      out.push(`;${line}`);
      continue;
    }
    if (!type || !(ALLOWED_TOC_TYPES as readonly string[]).includes(type)) {
      rejected.push(type ? `${type} ${rest.trim()}`.slice(0, 80) : `unbekannt: ${body.slice(0, 60)}`);
      continue;
    }
    // COMMENT nur auf erlaubten Objekten (nicht auf Funktionen, Erweiterungen …)
    if (type === "COMMENT") {
      const tag = rest.replace(/^\S+ /, ""); // Schema bzw. „-“ weg → „TABLE users schulos“, „FUNCTION f() schulos“
      const target = KNOWN_TYPES.find((t) => tag.startsWith(`${t} `));
      if (target && !(ALLOWED_TOC_TYPES as readonly string[]).includes(target)) {
        rejected.push(`COMMENT ${rest.trim()}`.slice(0, 80));
        continue;
      }
    }
    entries++;
    out.push(line);
  }
  return { list: out.join("\n"), entries, rejected };
}
