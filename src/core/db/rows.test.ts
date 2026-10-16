import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rowsOf } from "./rows";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("rowsOf (PGlite und postgres-js)", () => {
  it("liest beide Ergebnisformen", () => {
    expect(rowsOf<{ n: number }>({ rows: [{ n: 1 }] })).toEqual([{ n: 1 }]);
    expect([...rowsOf<{ n: number }>(Object.assign([{ n: 2 }], { count: 1 }))]).toEqual([{ n: 2 }]);
    expect(rowsOf({})).toEqual([]);
  });

  it("kein Code liest `.rows` von db.execute() direkt (liefe nur unter PGlite)", () => {
    const offenders = sources(path.join(process.cwd(), "src")).filter((f) => /as unknown as \{ rows\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
