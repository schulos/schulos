import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, grants, notifications, parentChild, sessions, twoFactorCodeLists } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { loadPermissions } from "@/core/permissions";
import { createUserWithPassword } from "./auth";
import { codeHash, codeListStatus, createCodeList, CodeListError, newCode, normalizeCode, redeemCode } from "./codeliste";
import { withNetworkRules } from "./pflicht";
import { resetTwoFactor } from "./zwei-faktor";

const OUTSIDE = new Headers({ "x-forwarded-for": "203.0.113.7" });

describe("SEC-02: Code-Liste (rein)", () => {
  it("Codes: 10 Zeichen ohne verwechselbare Zeichen, Eingabe tolerant, HMAC je Konto", () => {
    const c = newCode();
    expect(c).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(normalizeCode(" abcde - fghjk ")).toBe("ABCDEFGHJK");
    expect(codeHash("a", "ABCDE-FGHJK")).toBe(codeHash("a", "abcdefghjk"));
    expect(codeHash("a", "ABCDE-FGHJK")).not.toBe(codeHash("b", "ABCDE-FGHJK"));
  });
});

describe("SEC-02: Code-Liste mit Datenbank", () => {
  let h: DbHandle;

  async function session(id: string, userId: string) {
    await h.db.insert(sessions).values({ id, token: `t-${id}`, userId, expiresAt: new Date(Date.now() + 3_600_000) });
  }

  beforeAll(async () => {
    h = await createTestDb();
    for (const [id, role] of [
      ["sek", "verwaltung"],
      ["lea", "schueler"],
      ["mama", "eltern"],
      ["lk", "lehrkraft"],
    ] as const)
      await createUserWithPassword(h.db, { id, name: `Konto ${id}`, username: id, role }, { hash: "x" });
    await h.db.insert(parentChild).values({ parentId: "mama", childId: "lea" });
    await h.db.insert(grants).values({ permission: "verwaltung.users", role: "verwaltung" });
  });
  afterAll(() => h.close());

  it("nur für Schüler:innen; gespeichert nur HMACs; neue Liste macht die alte ungültig", async () => {
    await expect(createCodeList(h.db, "sek", "lk")).rejects.toBeInstanceOf(CodeListError);
    const first = await createCodeList(h.db, "sek", "lea");
    expect(first).toHaveLength(10);
    const [row] = await h.db.select().from(twoFactorCodeLists).where(eq(twoFactorCodeLists.userId, "lea"));
    expect(JSON.stringify(row)).not.toContain(first[0]!);
    expect(row!.codes).toContain(codeHash("lea", first[0]!));
    const second = await createCodeList(h.db, "sek", "lea");
    await session("s-old", "lea");
    await expect(redeemCode(h.db, "lea", "s-old", first[0]!)).rejects.toThrow("stimmt nicht");
    expect(second).not.toEqual(first);
    const [a] = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.user.2fa_codeliste"));
    expect(a?.target).toBe("lea");
  });

  it("G4E-S03: eine neue Liste beendet Sitzungen, die mit einem Code der alten Liste angemeldet wurden (die erste Liste nicht)", async () => {
    await createUserWithPassword(h.db, { id: "tim", name: "Konto tim", username: "tim", role: "schueler" }, { hash: "x" });
    await session("tim-schule", "tim");
    const first = await createCodeList(h.db, "sek", "tim");
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "tim"))).toHaveLength(1);
    // jemand mit Passwort und einem Code der (verlorenen) Liste meldet sich von außen an
    await session("tim-fremd", "tim");
    await redeemCode(h.db, "tim", "tim-fremd", first[0]!);
    expect((await withNetworkRules(h.db, OUTSIDE, "tim-fremd", await loadPermissions(h.db, "tim"))).twoFactorPending).toBe(false);
    // das Sekretariat druckt eine neue Liste – die markierte Sitzung darf nicht weiterlaufen
    await createCodeList(h.db, "sek", "tim");
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "tim"))).toEqual([]);
    const log = (await h.db.select().from(auditLog).where(eq(auditLog.target, "tim")).orderBy(auditLog.id)).filter((r) => r.action === "verwaltung.user.2fa_codeliste");
    expect(log.map((r) => r.meta ?? null)).toEqual([null, { sitzungenBeendet: 2 }]);
  });

  it("Schülerin von außen: erst nach Code frei, jeder Code nur einmal", async () => {
    const codes = await createCodeList(h.db, "sek", "lea");
    await session("s1", "lea");
    const perms = await loadPermissions(h.db, "lea");
    expect(await withNetworkRules(h.db, OUTSIDE, "s1", perms)).toMatchObject({ twoFactorPending: true, twoFactorReason: "aussen-code" });
    await redeemCode(h.db, "lea", "s1", codes[3]!.toLowerCase());
    expect((await withNetworkRules(h.db, OUTSIDE, "s1", perms)).twoFactorPending).toBeFalsy();
    expect((await codeListStatus(h.db, "lea"))?.remaining).toBe(9);
    await session("s2", "lea");
    await expect(redeemCode(h.db, "lea", "s2", codes[3]!)).rejects.toThrow("schon benutzt");
    // fremde Sitzung wird nicht gekennzeichnet
    await session("s-lk", "lk");
    await redeemCode(h.db, "lea", "s-lk", codes[4]!);
    const [lk] = await h.db.select().from(sessions).where(eq(sessions.id, "s-lk"));
    expect(lk!.secondFactorAt).toBeNull();
  });

  it("Raten wird gebremst", async () => {
    await session("s3", "lea");
    let last: unknown = null;
    for (let i = 0; i < 12; i++) last = await redeemCode(h.db, "lea", "s3", "AAAAA-AAAAA").catch((e: unknown) => e);
    expect(String(last)).toContain("Zu viele");
  });

  it("Zurücksetzen durch das Sekretariat: Liste weg, Sitzungen beendet, Gong an Schülerin und Eltern", async () => {
    await resetTwoFactor(h.db, "sek", "lea");
    expect(await codeListStatus(h.db, "lea")).toBeNull();
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, "lea"))).toHaveLength(0);
    const gongs = await h.db.select().from(notifications).where(eq(notifications.title, "Zwei-Faktor-Anmeldung zurückgesetzt"));
    expect(gongs.map((g) => g.userId).sort()).toEqual(["lea", "mama"]);
  });
});
