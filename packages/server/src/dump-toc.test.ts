import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDumpToc } from "./dump-toc";

// Ausschnitt aus `pg_restore --list` eines echten SchulOS-Dumps (PostgreSQL 18, alle Migrationen, pg_stat_statements)
const REAL = `;
; Archive created at 2026-10-10 09:54:45 UTC
;     dbname: schulos
;
; Selected TOC Entries:
;
7; 2615 18608 SCHEMA - drizzle schulos
3344; 3456 18179 COLLATION public schulos_de schulos
2; 3079 18564 EXTENSION - pg_stat_statements
4480; 0 0 COMMENT - EXTENSION pg_stat_statements
1072; 1247 17221 TYPE public absence_reason schulos
255; 1259 17233 TABLE public absence_reports schulos
4473; 0 18610 TABLE DATA drizzle __drizzle_migrations schulos
4481; 0 0 SEQUENCE OWNED BY drizzle __drizzle_migrations_id_seq schulos
226; 1259 16511 SEQUENCE public audit_log_id_seq schulos
4483; 0 0 SEQUENCE SET drizzle __drizzle_migrations_id_seq schulos
3809; 2604 18613 DEFAULT drizzle __drizzle_migrations id schulos
3963; 2606 17249 CONSTRAINT public absence_reports absence_reports_pkey schulos
4153; 2606 17260 FK CONSTRAINT public absence_reports absence_reports_decided_by_users_id_fk schulos
3964; 1259 17265 INDEX public absence_reports_student_idx schulos
`;

describe("Inhaltsverzeichnis eines Dumps (SEC-06)", () => {
  it("echter SchulOS-Dump: alles erlaubt, Abfragestatistik übersprungen", () => {
    const r = checkDumpToc(REAL);
    expect(r.rejected).toEqual([]);
    expect(r.entries).toBe(12);
    expect(r.list).toContain(";2; 3079 18564 EXTENSION - pg_stat_statements");
    expect(r.list).toContain(";4480; 0 0 COMMENT - EXTENSION pg_stat_statements");
    expect(r.list).toContain("\n255; 1259 17233 TABLE public absence_reports schulos");
  });

  it("lehnt Funktionen, Sprachen, fremde Erweiterungen, Trigger, Sichten und Unbekanntes ab", () => {
    const evil = [
      "10; 1255 1 FUNCTION public pwn() schulos",
      "11; 2612 2 PROCEDURAL LANGUAGE - plpython3u postgres",
      "12; 3079 3 EXTENSION - adminpack ",
      "13; 0 0 COMMENT - EXTENSION adminpack ",
      "14; 2620 4 TRIGGER public users t schulos",
      "15; 1259 5 MATERIALIZED VIEW public mv schulos",
      "16; 0 0 COMMENT public FUNCTION pwn() schulos",
      "17; 1 2 IRGENDWAS public x schulos",
      "kaputt",
    ].join("\n");
    const r = checkDumpToc(`${REAL}${evil}\n`);
    expect(r.rejected).toHaveLength(9);
    expect(r.rejected.join(" | ")).toMatch(/FUNCTION public pwn\(\).*PROCEDURAL LANGUAGE.*EXTENSION - adminpack.*COMMENT - EXTENSION adminpack.*TRIGGER.*MATERIALIZED VIEW.*COMMENT public FUNCTION.*unbekannt.*unlesbare/);
  });

  it("das Schema der Migrationen erzeugt nur erlaubte Arten (sonst Liste in dump-toc.ts ergänzen)", () => {
    const dir = path.join(import.meta.dirname, "..", "..", "..", "drizzle");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?(function|procedure|trigger|rule|view|materialized\s+view|extension|language|aggregate|operator|cast|domain|policy)\b/i);
  });
});
