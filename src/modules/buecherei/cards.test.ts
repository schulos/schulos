// Schulbücherei – Ausweis-Code (BU-07): pseudonym, zufällig, ersetzbar; Theke erkennt Ausweis- und Exemplar-Scans (SICHERHEIT S74).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, buechereiCards, groupMembers } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { cardClasses, cardsToPrint, classMemberIds, ensureCards, isCardCode, newCardCode, personByCard, replaceCard } from "./cards";
import { isValidCopyNumber } from "./labels";
import { scanAtDesk } from "./loans";
import { createTitle } from "./service";

const TODAY = "2026-10-19";
const SABINE = "u-sabine.kowalski";
const JANA = "u-jana.brandt";
const LEA = "u-lea.schaefer";

describe("Ausweis-Code – rein", () => {
  it("zufällig, ohne Namen/Kontonummer, unterscheidbar von Exemplarnummern", () => {
    const a = newCardCode();
    expect(isCardCode(a)).toBe(true);
    expect(isValidCopyNumber(a)).toBe(false);
    expect(newCardCode()).not.toBe(a);
    expect(newCardCode(() => new Uint8Array(10))).toBe("K-0000000000");
    expect(newCardCode(() => Uint8Array.from([31, 63, 255, 0, 1, 2, 3, 4, 5, 6]))).toBe("K-ZZZ0123456");
    expect(isCardCode("K-ILOU000000")).toBe(false); // verwechselbare Zeichen gibt es nicht
    expect(isCardCode("B-000001-8")).toBe(false);
    expect(a).not.toContain("lea");
  });
});

describe("Ausweis-Code", () => {
  let h: DbHandle;
  let helper: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    const [m] = await h.db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-buecherei"), eq(groupMembers.role, "member")));
    helper = m!.userId;
  });
  afterAll(async () => {
    await h.close();
  });

  it("S74: nur mit `buecherei.desk`", async () => {
    for (const id of [JANA, LEA]) {
      const perms = await p(id);
      await expect(ensureCards(h.db, perms, [LEA])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(replaceCard(h.db, perms, LEA)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(personByCard(h.db, perms, "K-0000000000")).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cardsToPrint(h.db, perms, { groupId: "g-7b" })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("klassenweise anlegen: je Konto ein Code, vorhandene bleiben, Eltern/Admin nie", async () => {
    const team = await p(helper);
    const ids = await classMemberIds(h.db, team, "g-7b");
    expect(ids).toContain(LEA);
    const n = await ensureCards(h.db, team, [...ids, "u-admin"]);
    expect(n).toBe(ids.length);
    expect(await ensureCards(h.db, team, ids)).toBe(0);
    const print = await cardsToPrint(h.db, team, { groupId: "g-7b" });
    expect(print!.title).toBe("Klasse 7b");
    expect(print!.cards.every((c) => c.code && isCardCode(c.code) && c.className === "7b")).toBe(true);
    expect(new Set(print!.cards.map((c) => c.code)).size).toBe(print!.cards.length);
    expect(await h.db.select().from(buechereiCards).where(eq(buechereiCards.userId, "u-admin"))).toEqual([]);
    const cls = (await cardClasses(h.db, team)).find((c) => c.id === "g-7b");
    expect(cls).toMatchObject({ members: print!.cards.length, cards: print!.cards.length });
  });

  it("Verlust: neuer Code, der alte ist sofort ungültig (protokolliert)", async () => {
    const team = await p(helper);
    const before = (await cardsToPrint(h.db, team, { userId: LEA }))!.cards[0]!.code!;
    expect(await personByCard(h.db, team, before)).toBe(LEA);
    const after = await replaceCard(h.db, team, LEA);
    expect(after).not.toBe(before);
    expect(await personByCard(h.db, team, before)).toBeNull();
    expect(await personByCard(h.db, team, after)).toBe(LEA);
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.target, LEA))).map((a) => a.action);
    expect(actions).toContain("buecherei.card.replace");
  });

  it("Theke erkennt Ausweis- und Exemplar-Scans: Ausweis wählt die Person, danach Ausleihe", async () => {
    const team = await p(helper);
    const { barcodes } = await createTitle(h.db, await p(SABINE), { title: "Ausweisprobe", mediaType: "buch" }, { count: 1 });
    const code = (await cardsToPrint(h.db, team, { userId: LEA }))!.cards[0]!.code!;
    const r = await scanAtDesk(h.db, team, ` ${code.toLowerCase()} `, null, TODAY);
    expect(r).toEqual({ kind: "person", userId: LEA });
    expect(await scanAtDesk(h.db, team, barcodes[0]!, LEA, TODAY)).toMatchObject({ kind: "loan" });
    await expect(scanAtDesk(h.db, team, "K-0000000000", null, TODAY)).rejects.toMatchObject({ fieldErrors: { code: expect.stringMatching(/Ausweis unbekannt/) } });
  });
});
