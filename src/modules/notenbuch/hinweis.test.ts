// Notenbuch (P5-17): Datenschutzhinweis beim ersten Öffnen – Bestätigung je Konto und Fassung, nur für Notenbuch-Nutzer:innen,
// geht mit dem Konto.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { appSettings, notenbuchNoticeAcks, schoolYears, users } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { userRefs } from "@/core/privacy/refs";
import { DSB_TOPICS } from "@/core/privacy/checkliste";
import { acknowledgeNotice, NOTICE_POINTS, NOTICE_VERSION, noticeAcknowledged, noticeCurrent } from "./hinweis";

const JANA = "u-jana.brandt";
const SABINE = "u-sabine.kowalski"; // Verwaltung ohne Notenbuch-Recht
const LEA = "u-lea.schaefer";

describe("Notenbuch: Datenschutzhinweis (P5-17)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
  }, 60_000);
  afterAll(() => h.close());

  it("Fassung: nur die aktuelle (oder neuere) Bestätigung gilt", () => {
    expect(noticeCurrent(undefined)).toBe(false);
    expect(noticeCurrent(null)).toBe(false);
    expect(noticeCurrent(NOTICE_VERSION - 1)).toBe(false);
    expect(noticeCurrent(NOTICE_VERSION)).toBe(true);
    // Q-5A-22: je Schuljahr neu
    expect(noticeCurrent(NOTICE_VERSION, new Date("2026-08-03T08:00:00Z"), "2026-08-01")).toBe(true);
    expect(noticeCurrent(NOTICE_VERSION, new Date("2026-07-31T21:59:00Z"), "2026-08-01")).toBe(false);
    expect(noticeCurrent(NOTICE_VERSION, new Date("2026-07-31T22:30:00Z"), "2026-08-01")).toBe(true); // 00:30 Berlin
    expect(noticeCurrent(NOTICE_VERSION, null, "2026-08-01")).toBe(false);
    expect(noticeCurrent(NOTICE_VERSION - 1, new Date("2026-09-01T08:00:00Z"), "2026-08-01")).toBe(false);
    // der Hinweis nennt Dienstgerät/Genehmigung, Kopien und Gesundheitsangaben
    const text = NOTICE_POINTS.join(" ");
    expect(text).toMatch(/§ 2 Abs\. 2 VO-DV I/);
    expect(text).toMatch(/Bildschirmfotos/);
    expect(text).toMatch(/Gesundheit/);
  });

  it("erst offen, nach Bestätigung erledigt; eine neue Fassung verlangt erneut die Bestätigung", async () => {
    expect(await noticeAcknowledged(h.db, JANA)).toBe(false);
    await acknowledgeNotice(h.db, await p(JANA), new Date("2026-10-13T08:00:00Z"));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(true);
    // wiederholt bestätigen ist harmlos (eine Zeile je Konto)
    await acknowledgeNotice(h.db, await p(JANA));
    expect(await h.db.select().from(notenbuchNoticeAcks).where(eq(notenbuchNoticeAcks.userId, JANA))).toHaveLength(1);
    await h.db
      .update(notenbuchNoticeAcks)
      .set({ version: NOTICE_VERSION - 1 })
      .where(eq(notenbuchNoticeAcks.userId, JANA));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(false);
    await acknowledgeNotice(h.db, await p(JANA));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(true);
  });

  it("Q-5A-22: eine Bestätigung aus dem Vorjahr gilt im neuen Schuljahr nicht mehr", async () => {
    await acknowledgeNotice(h.db, await p(JANA), new Date("2026-10-13T08:00:00Z"));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(true);
    const [year] = await h.db.select().from(schoolYears).where(eq(schoolYears.isCurrent, true));
    await h.db
      .update(notenbuchNoticeAcks)
      .set({ acknowledgedAt: new Date(`${Number(year!.startsOn.slice(0, 4)) - 1}-10-01T08:00:00Z`) })
      .where(eq(notenbuchNoticeAcks.userId, JANA));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(false);
    await acknowledgeNotice(h.db, await p(JANA));
    expect(await noticeAcknowledged(h.db, JANA)).toBe(true);
  });

  it("nur wer das Notenbuch nutzen darf, kann bestätigen; gesperrte Konten nicht", async () => {
    for (const id of [LEA, SABINE]) await expect(acknowledgeNotice(h.db, await p(id)), id).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acknowledgeNotice(h.db, { ...(await p(JANA)), locked: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await noticeAcknowledged(h.db, LEA)).toBe(false);
  });

  it("geht mit dem Konto (Kaskade); Baustein für die Nutzungsordnung in der Checkliste", async () => {
    expect(userRefs()).toContainEqual({ table: "notenbuch_notice_acks", column: "user_id", onDelete: "cascade" });
    const topic = DSB_TOPICS.find((t) => t.id === "notenbuch")!;
    expect(topic.baustein).toMatch(/dienstlichen Geräten/);
    expect(topic.baustein).toMatch(/Zwei-Faktor/);
  });
});
