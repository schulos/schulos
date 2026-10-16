// GATE-5a: Jede Notenbuch-Aktion im Audit-Log hat eine lesbare Beschriftung im Protokoll (DA ADV 11.4 „feststellbar, wer wann
// was eingegeben hat“ – ein roher Schlüssel hilft der Schulleitung nicht), und das Protokoll lässt sich auf das Notenbuch filtern.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_FILTERS, ACTION_LABELS } from "@/modules/verwaltung/audit-view";

const DIR = join(process.cwd(), "src/modules/notenbuch");

/** Alle Aktionsnamen aus `audit(…)`/`auditRead(…)`-Aufrufen des Moduls (ohne Tests). */
function auditActions(): string[] {
  const out = new Set<string>();
  for (const file of readdirSync(DIR)) {
    if (!/\.tsx?$/.test(file) || file.includes(".test.")) continue;
    const src = readFileSync(join(DIR, file), "utf8");
    for (const m of src.matchAll(/\baudit(?:Read)?\(\s*[\w.]+,\s*[\w.]+,\s*"([^"]+)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

describe("Notenbuch im Protokoll", () => {
  it("findet die Audit-Aufrufe des Moduls (Plausibilität der Suche)", () => {
    const actions = auditActions();
    expect(actions).toContain("notenbuch.entsperren");
    expect(actions).toContain("lesen.notenbuch");
    expect(actions).toContain("notenbuch.offline.abgleich");
  });

  it("jede Aktion hat eine Beschriftung", () => {
    expect(auditActions().filter((a) => !ACTION_LABELS[a])).toEqual([]);
  });

  it("Bereich „Notenbuch“ im Filter; Lesezugriffe unter „Lesezugriffe“", () => {
    expect(ACTION_FILTERS.find((f) => f.value === "notenbuch.")?.label).toBe("Notenbuch");
    expect(ACTION_FILTERS.some((f) => "lesen.notenbuch".startsWith(f.value))).toBe(true);
  });
});
