import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, chatMessages, chatRooms, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { readModuleSetting, writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { CLASS_DAYS, collectRetention, PERIOD_MIN_DAYS, ruleText, type RetentionClassId } from "@/core/retention";
import { MODULES } from "@/modules";
import { EVENT_KEEP } from "@/modules/kalender/settings";
import { COUNSELING_KEEP, MESSAGE_KEEP } from "@/modules/messenger/settings";
import { ACCOUNT_GRACE } from "@/modules/verwaltung/settings";
import { setModuleSetting } from "@/modules/verwaltung/rights";
import { ValidationError } from "@/modules/verwaltung/users";
import { periodFor, periodSetting, readPeriods, validPeriod } from "./fristen";
import { accountGraceDays, planAccountDeletion } from "./konto";
import { planDeletion } from "./loeschlauf";
import { processingRecords } from "./hinweise";

describe("einstellbare Löschfristen (DS-15)", () => {
  const withPeriod = collectRetention(MODULES)
    .map((e) => e.decl)
    .filter((d): d is Extract<typeof d, { class: RetentionClassId }> & { period: string } => "class" in d && Boolean(d.period));

  it("jede einstellbare Frist hat eine Moduleinstellung mit sicheren Grenzen und der Regelfrist als Vorgabe", () => {
    expect(withPeriod.map((d) => d.period).sort()).toEqual(["kalender.keep_days", "messenger.counseling_keep_days", "messenger.keep_days", "messenger.keep_days", "verwaltung.account_grace"]);
    for (const d of withPeriod) {
      const st = periodSetting(d.period);
      expect(st, d.period).toBeDefined();
      const bounds = CLASS_DAYS[d.class]!;
      expect(Number(st!.default), d.period).toBe(bounds.rule);
      // Ändern nur mit dem Datenschutz-Recht
      expect(st!.permission).toBe("verwaltung.privacy");
      for (const o of st!.options) {
        expect(o.value, d.period).toMatch(/^\d+$/);
        expect(Number(o.value)).toBeGreaterThanOrEqual(PERIOD_MIN_DAYS);
        expect(Number(o.value)).toBeLessThanOrEqual(bounds.max);
      }
    }
    // Kommunikation ist keine Akte: Chats nie länger als ein Jahr, auch wenn die Klasse 2 Jahre zuließe
    expect(Math.max(...MESSAGE_KEEP.options.map((o) => Number(o.value)))).toBe(365);
  });

  it("validPeriod nimmt nur Zahlen innerhalb der Klassengrenzen", () => {
    expect(validPeriod("LK-1J", "90")).toBe(90);
    expect(validPeriod("LK-1J", "731")).toBeNull();
    expect(validPeriod("LK-1J", "29")).toBeNull();
    expect(validPeriod("LK-1J", "1 or 1=1")).toBeNull();
    expect(validPeriod("LK-SJ", "90")).toBeNull();
    expect(ruleText("LK-1J", 90)).toBe("90 Tage");
    expect(ruleText("LK-1J", 365)).toBe("1 Jahr");
    expect(ruleText("LK-KONTO", 30)).toBe("Sperre sofort, Löschung nach 30 Tagen");
    expect(ruleText("LK-KONTO", 90)).toBe("Sperre sofort, Löschung nach 90 Tagen");
    expect(ruleText("LK-TERMIN", 1095)).toBe("3 Jahre");
  });

  describe("mit Demo-Schule", () => {
    let h: DbHandle;
    beforeAll(async () => {
      h = await createSeededTestDb();
    });
    afterAll(() => h.close());

    it("ohne Einstellung gelten die Regelfristen", async () => {
      const periods = await readPeriods(h.db);
      expect(Object.fromEntries(periods)).toEqual({ "messenger.keep_days": 365, "messenger.counseling_keep_days": 90, "kalender.keep_days": 730, "verwaltung.account_grace": 90 });
      const messages = collectRetention(MODULES).find((e) => e.decl.table === "chat_messages")!.decl;
      expect(periodFor(messages, periods)).toBe(365);
      expect(await accountGraceDays(h.db)).toBe(90);
    });

    it("kürzere Chat-Frist: der Löschlauf zählt ältere Nachrichten als fällig; Datenschutzhinweise nennen die Frist", async () => {
      const [room] = await h.db.select({ id: chatRooms.id }).from(chatRooms).limit(1);
      const [sender] = await h.db.select({ id: users.id }).from(users).where(eq(users.username, "jana.brandt"));
      await h.db.insert(chatMessages).values({ roomId: room!.id, authorId: sender!.id, body: "DS-15 alt", createdAt: new Date("2026-06-01T10:00:00Z") });
      const count = async () => (await planDeletion(h.db, "2026-10-05")).find((p) => p.table === "chat_messages")!.count;
      const before = await count();
      await writeModuleSetting(h.db, MESSAGE_KEEP, "90");
      expect(await count()).toBeGreaterThan(before);
      const periods = await readPeriods(h.db);
      expect(periods.get("messenger.keep_days")).toBe(90);
      const messenger = processingRecords(MODULES, periods).find((r) => r.id === "messenger")!;
      expect(messenger.dataTypes.find((t) => t.purpose === "Schulkommunikation")!.retention).toBe("90 Tage");
      await writeModuleSetting(h.db, MESSAGE_KEEP, "365");
    });

    it("ein manipulierter Wert außerhalb der Grenzen wirkt nicht (Regelfrist)", async () => {
      const { appSettings } = await import("@/core/db/schema");
      await h.db.insert(appSettings).values({ key: "module.kalender.keep_days", value: "5000" }).onConflictDoUpdate({ target: appSettings.key, set: { value: "5000" } });
      expect(await readModuleSetting(h.db, EVENT_KEEP)).toBe("730");
      expect((await readPeriods(h.db)).get("kalender.keep_days")).toBe(730);
      await h.db.delete(appSettings).where(eq(appSettings.key, "module.kalender.keep_days"));
    });

    it("Karenz nach Abgang: Einstellung verschiebt die Fälligkeit", async () => {
      const [lea] = await h.db.select({ id: users.id }).from(users).where(eq(users.username, "lea.schaefer"));
      await h.db.update(users).set({ status: "locked", leftOn: "2026-08-01" }).where(eq(users.id, lea!.id));
      const due = async () => (await planAccountDeletion(h.db, "2026-09-15")).some((a) => a.id === lea!.id);
      expect(await due()).toBe(false); // 90 Tage ab 01.08. → 30.10.
      await writeModuleSetting(h.db, ACCOUNT_GRACE, "30");
      expect(await accountGraceDays(h.db)).toBe(30);
      expect(await due()).toBe(true);
      await writeModuleSetting(h.db, ACCOUNT_GRACE, "90");
      await h.db.update(users).set({ status: "active", leftOn: null }).where(eq(users.id, lea!.id));
    });

    it("ändern nur mit verwaltung.privacy – Rechte & Module allein reicht nicht; protokolliert", async () => {
      const messenger = MODULES.find((m) => m.id === "messenger")!;
      await expect(setModuleSetting(h.db, "u-admin", messenger, COUNSELING_KEEP.key, "30")).rejects.toBeInstanceOf(ValidationError);
      const noPrivacy = { ...(await loadPermissions(h.db, "u-admin")), role: "verwaltung" as const, granted: new Set(["verwaltung.rights"]) };
      await expect(setModuleSetting(h.db, "u-admin", messenger, COUNSELING_KEEP.key, "30", noPrivacy)).rejects.toBeInstanceOf(ValidationError);
      await setModuleSetting(h.db, "u-admin", messenger, COUNSELING_KEEP.key, "30", await loadPermissions(h.db, "u-admin"));
      expect(await readModuleSetting(h.db, COUNSELING_KEEP)).toBe("30");
      const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, "verwaltung.module.setting"));
      expect(rows.some((r) => (r.meta as { key?: string }).key === COUNSELING_KEEP.key)).toBe(true);
    });
  });
});
