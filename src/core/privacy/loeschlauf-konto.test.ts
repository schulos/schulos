// DS-21: Der nächtliche Löschlauf löscht Konten über dieselbe Bereinigung wie die Löschung auf Antrag (`deleteAccounts`) –
// Verweise ohne Fremdschlüssel (Zeitwünsche), Solver-Läufe (Kennung und Kürzel in Texten) und das Audit-Log (sofort pseudonymisiert).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { auditLog, timetableSolverRuns, timetableTimePrefs, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { audit } from "@/core/audit";
import { DELETED_TEACHER, labelPattern, scrubIds } from "@/modules/stundenplan/solverlauf-konto";
import { planningYear } from "@/modules/stundenplan/verteilung";
import { runDeletion } from "./loeschlauf";
import { auditPepper, pseudonymOf } from "./protokoll";
import { qid, refWhere, userRefs } from "./refs";

const today = "2026-10-05";
const ID = "u-ds21.weg";
const CODE = "WGX";

describe("labelPattern/scrubIds mit Kürzeln", () => {
  it("ersetzt Kürzel nur als ganzes Wort", () => {
    const re = labelPattern([CODE, null, " "]);
    expect(scrubIds(`7b Mathe (${CODE} + BRA)`, new Set(), re)).toBe(`7b Mathe (${DELETED_TEACHER} + BRA)`);
    expect(scrubIds(`${CODE} Mo: 2 Hohlstunden`, new Set(), re)).toBe(`${DELETED_TEACHER} Mo: 2 Hohlstunden`);
    expect(scrubIds(`${CODE}Y und X${CODE} bleiben`, new Set(), re)).toBe(`${CODE}Y und X${CODE} bleiben`);
    expect(labelPattern([null, ""])).toBeNull();
  });
});

describe("DS-21 Löschlauf = Kontolöschung (Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Konto mit Daten in allen betroffenen Tabellen: nach dem Löschlauf keine Verweise, Audit-Log pseudonymisiert, Kürzel ersetzt", async () => {
    const year = (await planningYear(h.db))!;
    await h.db
      .insert(users)
      .values({ id: ID, name: "Lehrkraft Weg", email: "ds21@schule.test", role: "lehrkraft", status: "locked", leftOn: "2025-01-10", shortCode: CODE });
    // Verweis ohne Fremdschlüssel (SOFT_REFS)
    await h.db.insert(timetableTimePrefs).values({ schoolYearId: year.id, kind: "teacher", targetId: ID, weekday: 0, periodNr: 1, value: -1 });
    // Audit-Log: als Handelnde, als Ziel und in meta
    await audit(h.db, ID, "test.ds21.selbst", null);
    await audit(h.db, "u-admin", "test.ds21.ziel", ID);
    await audit(h.db, "u-admin", "test.ds21.meta", null, { userId: ID });
    // Solver-Lauf: Kennung in Einheiten, Kürzel in Kostenposten, Gründen und Protokoll
    await h.db.insert(timetableSolverRuns).values({
      id: "run-ds21",
      schoolYearId: year.id,
      status: "done",
      result: {
        units: [{ id: "x", label: `7b Mathe (${CODE})`, groupIds: ["g-7b"], teacherIds: [ID], subjectId: "M", length: 1 }],
        costs: [{ category: "teacherGap", cost: 2, text: `${CODE} Mo: 2 Hohlstunden` }],
        unplaced: [{ unitId: "x", label: `7b Mathe (${CODE})`, reason: `${CODE}: 0 von 30 Slots frei`, causes: [] }],
      },
      log: [{ at: new Date().toISOString(), kind: "precheck", text: `Vorprüfung: ${CODE} überplant`, data: {} }],
    });

    const out = await runDeletion(h.db, "u-admin", today);
    expect(out.items.find((i) => i.table === "users")).toMatchObject({ deleted: expect.any(Number) });
    expect(out.items.find((i) => i.table === "users")?.error).toBeUndefined();
    expect(await h.db.$count(users, eq(users.id, ID))).toBe(0);

    // keine Verweise mehr – über alle bekannten Verweise (Fremdschlüssel per Introspektion + SOFT_REFS)
    const left: string[] = [];
    for (const r of userRefs()) {
      const res = await h.db.execute(sql`select count(*)::int as n from ${qid(r.table)} where ${refWhere(r, ID)}`);
      if (Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0)) left.push(`${r.table}.${r.column}`);
    }
    expect(left).toEqual([]);

    // Audit-Log: Einträge bleiben, aber pseudonymisiert
    const rows = await h.db.select().from(auditLog).where(sql`${auditLog.action} like 'test.ds21.%'`);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(ID);
    expect(rows.every((r) => r.pseudonymizedAt)).toBe(true);
    const pseudo = pseudonymOf(await auditPepper(h.db), ID);
    expect(rows.find((r) => r.action === "test.ds21.selbst")?.actorPseudonym).toBe(pseudo);

    // Solver-Lauf: weder Kennung noch Kürzel
    const [run] = await h.db.select().from(timetableSolverRuns).where(eq(timetableSolverRuns.id, "run-ds21"));
    const text = JSON.stringify([run!.result, run!.log]);
    expect(text).not.toContain(ID);
    expect(text).not.toContain(CODE);
    expect(text).toContain(`${DELETED_TEACHER} Mo: 2 Hohlstunden`);
  }, 120_000);
});
