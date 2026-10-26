import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { MODULES } from "@/modules";
import { ACTION_LABELS, listAudit } from "./audit-view";

/** Alle Aktionen, die der Code per `audit(db, actor, <aktion>, …)` schreibt – auch in Bedingungen (`a ? "x.ein" : "x.aus"`). */
function auditActionsInSource(): Map<string, string> {
  const src = join(import.meta.dirname, "..", "..");
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        const text = readFileSync(p, "utf8");
        for (const call of text.matchAll(/\baudit\(\s*[^,()]+(?:\(\))?\s*,\s*[^,]+,\s*([^,]+),/g))
          for (const lit of call[1]!.matchAll(/"([a-z]+\.[a-z0-9_.]+)"/g)) out.set(lit[1]!, p.slice(src.length + 1));
      }
    }
  };
  walk(src);
  return out;
}

describe("Protokoll-Beschriftungen (Review R3 N6)", () => {
  // Bereiche aus SP2 und die im Review genannten Aktionen – jede geschriebene Aktion braucht eine deutsche Beschriftung
  const SCOPES = ["stundenplan.", "kurswahl.", "verwaltung.room.", "buecherei.material.return_day", "buecherei.compensation."];

  it("findet die Aktionen im Code (Plausibilität der Suche)", () => {
    const found = auditActionsInSource();
    expect(found.has("verwaltung.room.activate")).toBe(true);
    expect(found.has("kurswahl.angebot.off_subject")).toBe(true);
    expect(found.size).toBeGreaterThan(100);
  });

  it("jede Aktion aus SP2-Bereichen hat eine deutsche Beschriftung", () => {
    const missing = [...auditActionsInSource()].filter(([a]) => SCOPES.some((s) => a.startsWith(s)) && !ACTION_LABELS[a]).map(([a, f]) => `${a} (${f})`);
    expect(missing).toEqual([]);
  });
});
import { addMembers, createGroup, deleteGroup } from "./groups";
import { setRoleGrant } from "./rights";
import { setUserLocked } from "./users";

describe("Protokoll-Ansicht", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    await setUserLocked(h.db, "u-admin", "u-lea.schaefer", true);
    const g = await createGroup(h.db, "u-sabine.kowalski", { name: "AG Imkern", kind: "ag" });
    await addMembers(h.db, "u-sabine.kowalski", g, ["u-lea.schaefer", "u-jana.brandt"]);
    await setRoleGrant(h.db, MODULES, "u-admin", "lehrkraft", "verwaltung.access", true);
    const tmp = await createGroup(h.db, "u-admin", { name: "Wegwerf", kind: "frei" });
    await deleteGroup(h.db, "u-admin", tmp);
  }, 60_000);
  afterAll(() => h.close());

  it("listet neueste zuerst mit Beschriftung, Akteur und aufgelöstem Ziel", async () => {
    const { rows, total } = await listAudit(h.db);
    expect(total).toBe(6);
    expect(rows[0]).toMatchObject({ label: "Gruppe gelöscht", actor: "Admin IT", target: "Wegwerf" });
    expect(rows.find((r) => r.action === "verwaltung.user.lock")).toMatchObject({ label: "Benutzer gesperrt", target: "Lea Schäfer" });
    expect(rows.find((r) => r.action === "verwaltung.group.members_add")).toMatchObject({ actor: "Sabine Kowalski", target: "AG Imkern", detail: "2 Personen" });
    expect(rows.find((r) => r.action === "verwaltung.rights.grant")).toMatchObject({ target: "Rolle Lehrkraft", detail: "verwaltung.access" });
  });

  it("filtert nach Bereich", async () => {
    const { rows } = await listAudit(h.db, { prefix: "verwaltung.group." });
    expect(rows.every((r) => r.action.startsWith("verwaltung.group."))).toBe(true);
    expect(rows).toHaveLength(4);
  });
});
