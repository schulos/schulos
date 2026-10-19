// Schulbücherei – Statistik (BU-05) ohne Personenbezug: Monate, Bestand, nie ausgeliehen, Aussonderungsvorschläge, Rechte.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiCopies } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { toBerlinDate } from "@/core/time";
import { checkin, checkout } from "./loans";
import { createTitle } from "./service";
import { lastMonths, loanStatistics, monthsBack, neverLoaned, stockStatistics, withdrawalSuggestions } from "./statistik";

const SABINE = "u-sabine.kowalski";
const JANA = "u-jana.brandt";
const LEA = "u-lea.schaefer";

describe("Statistik – rein", () => {
  it("Monate über den Jahreswechsel", () => {
    expect(lastMonths("2026-02-10", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthsBack("2026-02", 36)).toBe("2023-02");
  });
});

describe("Statistik", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  // Demo-Zähler und -Nutzung hängen am echten Tag – die Statistik rechnet ebenso
  const today = toBerlinDate(new Date());

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it("nur mit `buecherei.stock`", async () => {
    for (const id of [JANA, LEA]) {
      const perms = await p(id);
      await expect(loanStatistics(h.db, perms, today)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(stockStatistics(h.db, perms)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(neverLoaned(h.db, perms)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(withdrawalSuggestions(h.db, perms, today)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("Ausleihen je Monat und Medienart (12 Monate, auch leere) aus den Zählern", async () => {
    const s = await loanStatistics(h.db, await p(SABINE), today);
    expect(s.months).toHaveLength(12);
    expect(s.months.at(-1)!.month).toBe(today.slice(0, 7));
    expect(s.months.at(-2)!.loans.buch).toBe(31);
    expect(s.months.at(-2)!.total).toBe(33);
    expect(s.months.at(-1)!.dunnings).toBe(2);
    expect(s.totals.total).toBe(23 + 3 + 31 + 2 + 9 + 1);
    expect(s.max).toBe(33);
    // das Ergebnis enthält nur Zahlen – keine Personen
    expect(JSON.stringify(s)).not.toMatch(/u-|user/);
  });

  it("Bestand je Medienart, nie ausgeliehen, Aussonderungsvorschläge (Demo)", async () => {
    const s = await p(SABINE);
    const stock = await stockStatistics(h.db, s);
    const buch = stock.find((r) => r.mediaType === "buch")!;
    expect(buch).toMatchObject({ titles: 6, withdrawn: 1, active: 10, loaned: 2 });
    const never = await neverLoaned(h.db, s);
    expect(never.map((t) => t.title)).toEqual(["Atlas der Welt", "Brückenbauer (Brettspiel)"]);
    const sug = await withdrawalSuggestions(h.db, s, today, 3);
    const by = Object.fromEntries(sug.map((x) => [x.title, x.reason]));
    expect(by).toEqual({ "Die Nacht im Leuchtturm": "lange", "Vulkane und Erdbeben": "zustand", "Atlas der Welt": "nie" });
    // mit fünf Jahren fällt der Atlas (gut fünf Jahre alt) evtl. noch heraus, die lange nicht geliehene Nacht (gut 4 Jahre) sicher
    expect((await withdrawalSuggestions(h.db, s, today, 5)).map((x) => x.title)).not.toContain("Die Nacht im Leuchtturm");
  });

  it("Ausleihe zählt am Exemplar (Zahl, Monat) ohne Person; Rückgabe ohne Befund lässt nur Zahlen", async () => {
    const s = await p(SABINE);
    const { barcodes } = await createTitle(h.db, s, { title: "Zählbuch", mediaType: "buch" }, { count: 1 });
    expect((await neverLoaned(h.db, s)).map((t) => t.title)).toContain("Zählbuch");
    await checkout(h.db, s, LEA, barcodes[0]!, today);
    await checkin(h.db, s, barcodes[0]!, today);
    const [c] = await h.db.select().from(buechereiCopies).where(inArray(buechereiCopies.barcode, barcodes));
    expect(c).toMatchObject({ loanCount: 1, lastLoanMonth: today.slice(0, 7) });
    expect(Object.values(c!)).not.toContain(LEA);
    expect((await neverLoaned(h.db, s)).map((t) => t.title)).not.toContain("Zählbuch");
    const [after] = await h.db.select({ n: buechereiCopies.loanCount }).from(buechereiCopies).where(eq(buechereiCopies.id, c!.id));
    expect(after!.n).toBe(1);
  });
});
