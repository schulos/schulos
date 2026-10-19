// Schulbücherei – Etiketten (BU-05): Vorlagen, Startposition, Druckwarteschlange, „als gedruckt markieren“, Rechte.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiCopies } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { LABEL_TEMPLATES, clampStart, labelQueue, labelTemplate, labelsToPrint, layoutPages, markLabelsPrinted, markQueuePrinted, perSheet, requeueLabel, slotPosition } from "./etiketten";
import { createTitle, withdrawCopy } from "./service";

const SABINE = "u-sabine.kowalski"; // Verwaltung (stock)
const JANA = "u-jana.brandt"; // Lehrkraft ohne Team
const LEA = "u-lea.schaefer";

describe("Etiketten – rein", () => {
  it("Bögen passen auf A4, Rollen haben ein Etikett je Seite", () => {
    for (const t of LABEL_TEMPLATES) {
      if (t.kind === "rolle") {
        expect(perSheet(t)).toBe(1);
        continue;
      }
      const last = slotPosition(t, perSheet(t) - 1);
      expect(last.xMm + t.widthMm).toBeLessThanOrEqual(210);
      expect(last.yMm + t.heightMm).toBeLessThanOrEqual(297);
    }
  });

  it("Position zeilenweise von links oben", () => {
    const t = labelTemplate("a4-3x8");
    expect(slotPosition(t, 0)).toEqual({ xMm: 0, yMm: 0.5 });
    expect(slotPosition(t, 4)).toEqual({ xMm: 70, yMm: 37.5 });
  });

  it("unbekannte Vorlage → Vorgabe; Startposition begrenzt, Rolle immer 1", () => {
    expect(labelTemplate("gibtsnicht").id).toBe("a4-3x8");
    const t = labelTemplate("a4-3x8");
    expect(clampStart(t, "5")).toBe(5);
    expect(clampStart(t, "0")).toBe(1);
    expect(clampStart(t, "25")).toBe(1);
    expect(clampStart(t, "abc")).toBe(1);
    expect(clampStart(labelTemplate("rolle-62x29"), "5")).toBe(1);
  });

  it("Startposition lässt Plätze frei und bricht auf neue Bögen um", () => {
    const t = labelTemplate("a4-2x8"); // 16 je Bogen
    const pages = layoutPages(t, Array.from({ length: 20 }, (_, i) => i), 5);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slice(0, 4)).toEqual([null, null, null, null]);
    expect(pages[0]![4]).toBe(0);
    expect(pages[0]).toHaveLength(16);
    expect(pages[1]).toHaveLength(8);
    expect(layoutPages(labelTemplate("rolle-54x25"), ["a", "b"], 7)).toEqual([["a"], ["b"]]);
  });
});

describe("Etiketten", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let ids: string[];
  let titleId: string;

  beforeAll(async () => {
    h = await createSeededTestDb();
    const r = await createTitle(h.db, await p(SABINE), { title: "Etikettenbuch", mediaType: "buch" }, { count: 3, signature: "ET 1" });
    titleId = r.id;
    ids = (await h.db.select({ id: buechereiCopies.id }).from(buechereiCopies).where(inArray(buechereiCopies.barcode, r.barcodes)).orderBy(buechereiCopies.seq)).map((c) => c.id);
  });
  afterAll(async () => {
    await h.close();
  });

  it("nur mit `buecherei.stock`", async () => {
    for (const id of [JANA, LEA]) {
      const perms = await p(id);
      await expect(labelQueue(h.db, perms)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(labelsToPrint(h.db, perms, { kind: "warteschlange" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markLabelsPrinted(h.db, perms, ids, new Date())).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markQueuePrinted(h.db, perms, new Date())).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("neue Exemplare stehen in der Warteschlange (Demo: zwei offen), ausgesonderte nicht", async () => {
    const s = await p(SABINE);
    const q = await labelQueue(h.db, s);
    expect(q.count).toBe(5);
    expect(q.rows.map((r) => r.copyId)).toEqual(expect.arrayContaining(ids));
    await withdrawCopy(h.db, s, ids[2]!, "Fehldruck", "2026-10-19");
    expect((await labelQueue(h.db, s)).count).toBe(4);
    const labels = await labelsToPrint(h.db, s, { kind: "titel", titleId });
    expect(labels.map((l) => l.copyId)).toEqual([ids[0], ids[1]]);
    expect(labels[0]).toMatchObject({ signature: "ET 1", title: "Etikettenbuch", printed: false });
  });

  it("als gedruckt markieren nimmt genau die gedruckten aus der Warteschlange; nachdrucken und zurück in die Warteschlange", async () => {
    const s = await p(SABINE);
    expect(await markLabelsPrinted(h.db, s, [ids[0]!], new Date())).toBe(1);
    expect(await markLabelsPrinted(h.db, s, [ids[0]!], new Date())).toBe(0); // schon gedruckt
    const q = await labelQueue(h.db, s);
    expect(q.rows.map((r) => r.copyId)).not.toContain(ids[0]);
    expect(q.rows.map((r) => r.copyId)).toContain(ids[1]);
    // Einzeletikett zum Nachdrucken geht auch für gedruckte
    expect(await labelsToPrint(h.db, s, { kind: "exemplar", copyId: ids[0]! })).toEqual([expect.objectContaining({ copyId: ids[0], printed: true })]);
    await requeueLabel(h.db, s, ids[0]!);
    expect((await labelQueue(h.db, s)).rows.map((r) => r.copyId)).toContain(ids[0]);
    await expect(requeueLabel(h.db, s, ids[0]!)).rejects.toThrow();
    await expect(markLabelsPrinted(h.db, s, [], new Date())).rejects.toThrow();
  });

  it("ganze Warteschlange als gedruckt markieren", async () => {
    const s = await p(SABINE);
    expect(await markQueuePrinted(h.db, s, new Date())).toBeGreaterThan(0);
    expect((await labelQueue(h.db, s)).count).toBe(0);
    const [c] = await h.db.select({ at: buechereiCopies.labelPrintedAt }).from(buechereiCopies).where(eq(buechereiCopies.id, ids[1]!));
    expect(c!.at).toBeInstanceOf(Date);
  });
});
