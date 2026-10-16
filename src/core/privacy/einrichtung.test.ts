import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import type { CurrentUser } from "@/core/auth/session";
import type { DbHandle } from "@/core/db/client";
import { appSettings, auditLog } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { loadPermissions } from "@/core/permissions";
import { collectRetention } from "@/core/retention";
import { MODULES } from "@/modules";
import { COUNSELING_CHAT } from "@/modules/messenger/settings";
import { privacySetupItem, verwaltungOpen } from "@/modules/verwaltung/open";
import { ValidationError } from "@/modules/verwaltung/users";
import { DSB_TOPICS } from "./checkliste";
import { confirmResponsibility, readSetup, revokeConfirmation, setTopicStatus, setupExport } from "./einrichtung";
import { savePrivacyTexts } from "./hinweise";

const ADMIN = "u-admin";
const okBackup = () => ({ paired: true, health: "ok", lastOkAt: new Date().toISOString() }) as never;

describe("Datenschutz-Einrichtung (DS-12)", () => {
  let h: DbHandle;
  const openItems = async (userId: string) => {
    const perms = await loadPermissions(h.db, userId);
    return verwaltungOpen(okBackup).collect(h.db, { perms } as CurrentUser, new Date());
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(like(appSettings.key, "privacy.%"));
  }, 60_000);
  afterAll(() => h.close());

  it("Ausgangslage: nichts bestätigt, alle Punkte offen – Hinweis auf Heute nur für das Datenschutzrecht", async () => {
    const s = await readSetup(h.db);
    expect(s).toMatchObject({ confirmed: false, done: false, open: DSB_TOPICS.length + 1 });
    expect(s.missingTexts).toEqual(["controller", "dpo", "operator"]);
    expect((await openItems(ADMIN)).map((i) => i.id)).toContain("verwaltung:datenschutz");
    expect(await openItems("u-jana.brandt")).toEqual([]);
    expect(privacySetupItem(s)).toMatchObject({ label: "Datenschutz-Einrichtung durch die Schule", tone: "warn", href: "/verwaltung/datenschutz/einrichtung" });
  });

  it("Bestätigung nur mit Häkchen und mit eingetragener Verantwortlicher Stelle und DSB; protokolliert", async () => {
    await expect(confirmResponsibility(h.db, ADMIN, false)).rejects.toBeInstanceOf(ValidationError);
    await expect(confirmResponsibility(h.db, ADMIN, true)).rejects.toThrow(ValidationError);
    expect((await readSetup(h.db)).confirmed).toBe(false);
    await savePrivacyTexts(h.db, ADMIN, { controller: "Gesamtschule Lindenhof, vertreten durch die Schulleitung", dpo: "Frau Muster (Schulamt), dsb@example.org" });
    await confirmResponsibility(h.db, ADMIN, true, new Date("2026-10-12T08:00:00Z"));
    const s = await readSetup(h.db);
    expect(s).toMatchObject({ confirmed: true, confirmedAt: "2026-10-12T08:00:00.000Z", confirmedDpo: "Frau Muster (Schulamt), dsb@example.org", open: DSB_TOPICS.length });
    // bestätigt, aber Punkte offen → Hinweis bleibt
    expect(privacySetupItem(s)).toMatchObject({ label: "Datenschutz-Einrichtung unvollständig", detail: `${DSB_TOPICS.length} Punkte der DSB-Checkliste offen` });
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.einrichtung.bestaetigt"))).length).toBe(1);
  });

  it("Status je Punkt: prüft Eingaben; alle Punkte erledigt → kein Hinweis mehr", async () => {
    await expect(setTopicStatus(h.db, ADMIN, "gibts-nicht", "vorgabe", "")).rejects.toBeInstanceOf(ValidationError);
    await expect(setTopicStatus(h.db, ADMIN, "beratung", "vorgabe", "x".repeat(501))).rejects.toBeInstanceOf(ValidationError);
    await expect(setTopicStatus(h.db, ADMIN, "beratung", "kaputt" as never, "")).rejects.toBeInstanceOf(ValidationError);
    for (const t of DSB_TOPICS) await setTopicStatus(h.db, ADMIN, t.id, t.id === "beratung" ? "dsb" : "vorgabe", t.id === "beratung" ? "Chat bleibt aus (Votum 10/2026)" : "");
    const s = await readSetup(h.db);
    expect(s.done).toBe(true);
    expect(s.topics.find((t) => t.id === "beratung")).toMatchObject({ status: "dsb", note: "Chat bleibt aus (Votum 10/2026)", done: true });
    expect(privacySetupItem(s)).toBeNull();
    expect((await openItems(ADMIN)).map((i) => i.id)).not.toContain("verwaltung:datenschutz");
  });

  it("eine Einstellung danach geändert → Punkt wieder offen („seit der Prüfung geändert“)", async () => {
    await writeModuleSetting(h.db, COUNSELING_CHAT, "an");
    const s = await readSetup(h.db);
    const t = s.topics.find((x) => x.id === "beratung")!;
    expect(t).toMatchObject({ stale: true, done: false });
    expect(t.settingsState.find((x) => x.key === COUNSELING_CHAT.key)).toMatchObject({ value: "an", changed: true, defaultValue: "aus" });
    expect(s.done).toBe(false);
    expect(privacySetupItem(s)?.detail).toBe("1 Punkt der DSB-Checkliste offen");
    await setTopicStatus(h.db, ADMIN, "beratung", "geaendert", "nach Votum eingeschaltet");
    expect((await readSetup(h.db)).done).toBe(true);
  });

  it("Nachweis (JSON) enthält Bestätigung, alle Punkte, alle Einstellungen und alle Manifest-Fristen; Abruf protokolliert", async () => {
    const out = await setupExport(h.db, ADMIN, "Gesamtschule Lindenhof", new Date("2026-10-12T09:00:00Z"));
    expect(out.titel).toBe("Datenschutz-Konfiguration Gesamtschule Lindenhof");
    expect(out.bestaetigung).toMatchObject({ bestaetigt: true, dsb: "Frau Muster (Schulamt), dsb@example.org" });
    expect(out.themen.map((t) => t.id)).toEqual(DSB_TOPICS.map((t) => t.id));
    expect(out.themen.flatMap((t) => t.einstellungen.map((e) => e.schluessel)).sort()).toEqual(MODULES.flatMap((m) => m.settings ?? []).map((s) => s.key).sort());
    const all = collectRetention(MODULES);
    expect(out.loeschfristen).toHaveLength(all.length);
    for (const { decl } of all) expect(out.loeschfristen.some((f) => f.tabelle === decl.table && f.teilmenge === (decl.scope ?? null))).toBe(true);
    expect(out.loeschfristen.find((f) => f.tabelle === "chat_messages")).toMatchObject({ frist: "1 Jahr", einstellbar_ueber: "messenger.keep_days" });
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "datenschutz.einrichtung.export"))).length).toBe(1);
  });

  it("Bestätigung zurücknehmen → Einrichtung wieder offen", async () => {
    await revokeConfirmation(h.db, ADMIN);
    const s = await readSetup(h.db);
    expect(s).toMatchObject({ confirmed: false, done: false, open: 1 });
  });
});
