// Notenbuch (P5-20): Offline-Eingabe auf Dienstgeräten – wo erlaubt (Einstellung × Zone × Gerätezertifikat), Lebenszyklus des
// Server-Schlüsselanteils (Einschalten, Abruf bindet an die Sitzung, Abmelden/Sitzung weg → Kaskade, Frist, Rechteentzug,
// fremde Person), Abgleich (anwenden, idempotent, Konflikt mit Server-Wert, gesperrtes Buch lehnt ab, Audit mit Zahlen).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  appSettings,
  auditLog,
  deviceCerts,
  grants,
  notenbuchBooks,
  notenbuchEntries,
  notenbuchOfflineDevices,
  schoolYears,
  sessions,
  timetableAssignmentGroups,
  timetableAssignments,
  timetableAssignmentTeachers,
  timetableLessons,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import {
  activateOfflineDevice,
  deactivateOfflineDevice,
  decideOffline,
  endOfflineForSession,
  offlineDecision,
  offlineShare,
  parseOp,
  purgeExpiredOfflineDevices,
  syncOfflineOps,
} from "./offline";
import { OFFLINE_MAX_DAYS, type OfflineOp } from "./offline-sync";
import { addColumn, createBook, getBook, lockBook, setEntry, setFinalGrade } from "./service";
import { OFFLINE } from "./settings";

const TODAY = "2026-10-07";
const JANA = "u-jana.brandt";
const TOBIAS = "u-tobias.kleine";
const MURAT = "u-murat.yilmaz";
const T0 = new Date("2026-10-07T08:00:00Z");
const after = (days: number) => new Date(T0.getTime() + days * 86_400_000);
const FP_JANA = "a".repeat(64);
const FP_FREI = "b".repeat(64);
const FP_GESPERRT = "c".repeat(64);
const DEV = "11111111-1111-4111-8111-111111111111";
const DEV2 = "22222222-2222-4222-8222-222222222222";

const intern = new Headers();
const privat = new Headers({ "x-schulos-extern": "alles" });
const geraet = (fp: string) => new Headers({ "x-schulos-extern": "geraet", "x-schulos-geraet": fp });

const op = (over: Partial<OfflineOp>): OfflineOp => ({
  opId: crypto.randomUUID(),
  columnId: "",
  studentId: "",
  value: "2",
  comment: null,
  baseVersion: 0,
  at: T0.toISOString(),
  ...over,
});

describe("Notenbuch: Offline-Eingabe (P5-20)", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  let bookId = "";
  let col = "";
  let lea = "";
  let other = "";

  beforeAll(async () => {
    h = await createSeededTestDb();
    await h.db.delete(appSettings).where(eq(appSettings.key, "demo"));
    await h.db.update(users).set({ twoFactorEnabled: true });
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAssignments);
    const [year] = await h.db.select({ id: schoolYears.id }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const [a] = await h.db.insert(timetableAssignments).values({ schoolYearId: year!.id, subjectId: "D", hours: 4 }).returning({ id: timetableAssignments.id });
    await h.db.insert(timetableAssignmentGroups).values({ assignmentId: a!.id, groupId: "g-7b" });
    await h.db.insert(timetableAssignmentTeachers).values([
      { assignmentId: a!.id, teacherId: JANA },
      { assignmentId: a!.id, teacherId: TOBIAS },
    ]);
    bookId = await createBook(h.db, await p(JANA), { groupId: "g-7b", subjectId: "D", term: 1, scale: "noten6" }, TODAY);
    col = await addColumn(h.db, await p(JANA), bookId, { kind: "sonstige", title: "Mündlich" });
    const view = (await getBook(h.db, await p(JANA), bookId))!;
    lea = view.students.find((s) => s.id === "u-lea.schaefer")!.id;
    other = view.students.find((s) => s.id !== lea)!.id;
    const s = (id: string, userId: string) => ({ id, token: `t-${id}`, userId, expiresAt: after(7) });
    await h.db.insert(sessions).values([s("s1", JANA), s("s2", JANA), s("s3", MURAT)]);
    const cert = (fingerprint: string, userId: string | null, revokedAt: Date | null = null) => ({
      label: "Test",
      commonName: `geraet-${fingerprint.slice(0, 4)}`,
      fingerprint,
      serial: fingerprint.slice(0, 8),
      notBefore: after(-1),
      notAfter: after(365),
      userId,
      revokedAt,
    });
    await h.db.insert(deviceCerts).values([cert(FP_JANA, JANA), cert(FP_FREI, null), cert(FP_GESPERRT, null, T0)]);
  }, 60_000);
  afterAll(() => h.close());

  it("rein: Einstellung × Zone × Zertifikat – im Zweifel nein", () => {
    expect(decideOffline("aus", "intern", "gebunden")).toMatchObject({ allowed: false, reason: "aus" });
    expect(decideOffline("zertifikat", "geraet", "gebunden")).toMatchObject({ allowed: true, reason: "zertifikat" });
    expect(decideOffline("zertifikat", "alles", "gueltig")).toMatchObject({ allowed: true, reason: "zertifikat" });
    expect(decideOffline("zertifikat", "intern", "fehlt")).toMatchObject({ allowed: false, reason: "kein-zertifikat" });
    expect(decideOffline("zertifikat", "alles", "fehlt")).toMatchObject({ allowed: false, reason: "privatgeraet" });
    expect(decideOffline("zertifikat", "alles", "ungueltig")).toMatchObject({ allowed: false, reason: "privatgeraet" });
    expect(decideOffline("schulnetz", "intern", "fehlt")).toMatchObject({ allowed: true, reason: "schulnetz" });
    expect(decideOffline("schulnetz", "alles", "fehlt")).toMatchObject({ allowed: false, reason: "privatgeraet" });
    expect(decideOffline("schulnetz", "geraet", "gebunden")).toMatchObject({ allowed: true, reason: "zertifikat" });
    expect(decideOffline("schulnetz", "oeffentlich", "gebunden")).toMatchObject({ allowed: false, reason: "privatgeraet" });
  });

  it("Entscheidung je Anfrage: Vorgabe „zertifikat“ – nur mit gültigem, freigegebenem Zertifikat (gebunden oder frei), nie gesperrt/fremd", async () => {
    const jana = await p(JANA);
    expect((await offlineDecision(h.db, jana, intern, T0)).reason).toBe("kein-zertifikat");
    expect((await offlineDecision(h.db, jana, privat, T0)).reason).toBe("privatgeraet");
    expect(await offlineDecision(h.db, jana, geraet(FP_JANA), T0)).toMatchObject({ allowed: true, reason: "zertifikat" });
    expect(await offlineDecision(h.db, jana, geraet(FP_FREI), T0)).toMatchObject({ allowed: true, reason: "zertifikat" });
    expect((await offlineDecision(h.db, jana, geraet(FP_GESPERRT), T0)).allowed).toBe(false);
    expect((await offlineDecision(h.db, jana, geraet("d".repeat(64)), T0)).allowed).toBe(false);
    // an Jana gebunden → für Tobias ungültig
    expect((await offlineDecision(h.db, await p(TOBIAS), geraet(FP_JANA), T0)).allowed).toBe(false);
    // ein mitgeschickter Leer-Hash (Caddy ohne Zertifikat) zählt nie
    expect((await offlineDecision(h.db, jana, geraet("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), T0)).allowed).toBe(false);
  });

  it("Einschalten: nur wo erlaubt, Schulnetz nur mit Bestätigung, Privatgerät nie; Server-Anteil mit Frist, Audit", async () => {
    const jana = await p(JANA);
    await expect(activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s1", confirmed: true }, T0)).rejects.toThrow(ValidationError);
    await expect(activateOfflineDevice(h.db, jana, privat, { deviceId: DEV, sessionId: "s1", confirmed: true }, T0)).rejects.toThrow(ValidationError);
    await expect(activateOfflineDevice(h.db, jana, geraet(FP_JANA), { deviceId: "kein-uuid", sessionId: "s1", confirmed: false }, T0)).rejects.toThrow(
      ValidationError,
    );
    const r = await activateOfflineDevice(h.db, jana, geraet(FP_JANA), { deviceId: DEV, sessionId: "s1", confirmed: false }, T0);
    expect(r.reason).toBe("zertifikat");
    expect(r.share).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(r.expiresAt).toEqual(after(OFFLINE_MAX_DAYS));
    await writeModuleSetting(h.db, OFFLINE, "schulnetz");
    await expect(activateOfflineDevice(h.db, jana, intern, { deviceId: DEV2, sessionId: "s1", confirmed: false }, T0)).rejects.toMatchObject({
      fieldErrors: { confirmed: expect.stringContaining("Dienstgerät") },
    });
    await expect(activateOfflineDevice(h.db, jana, privat, { deviceId: DEV2, sessionId: "s1", confirmed: true }, T0)).rejects.toMatchObject({
      fieldErrors: { offline: expect.stringContaining("Privatgeräten") },
    });
    const r2 = await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV2, sessionId: "s1", confirmed: true }, T0);
    expect(r2.reason).toBe("schulnetz");
    expect(r2.share).not.toBe(r.share);
    const rows = await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.userId, JANA));
    expect(rows.map((x) => x.deviceId).sort()).toEqual([DEV, DEV2]);
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.offline.ein")).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(log!.meta).toMatchObject({ grund: "schulnetz" });
    // ohne `notenbuch.own` kein Einschalten
    await expect(activateOfflineDevice(h.db, await p("u-admin"), intern, { deviceId: DEV2, sessionId: "s1", confirmed: true }, T0)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("Abruf: derselbe Anteil, Sitzung neu gebunden; fremde Person → null, Zeile bleibt (G5A-S05); ohne Berechtigung am Ort nur noch zum Übertragen bis zum nächtlichen Lauf", async () => {
    const jana = await p(JANA);
    const first = await offlineShare(h.db, jana, intern, { deviceId: DEV2, sessionId: "s2" }, after(1));
    expect(first).toMatchObject({ keep: true, reason: "schulnetz" });
    const [row] = await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV2));
    expect(row!.sessionId).toBe("s2");
    expect(row!.serverShare).toBe(first!.share);
    // unbekanntes Gerät
    expect(await offlineShare(h.db, jana, intern, { deviceId: "33333333-3333-4333-8333-333333333333", sessionId: "s2" }, after(1))).toBeNull();
    // G5A-S05: fremde Person (geteiltes Dienstgerät) bekommt nichts – und löscht auch nichts
    expect(await offlineShare(h.db, await p(MURAT), intern, { deviceId: DEV, sessionId: "s3" }, after(1))).toBeNull();
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toEqual([
      expect.objectContaining({ userId: JANA }),
    ]);
    // jetzt von außen ohne Zertifikat (Privatgerät): Anteil nur noch zum Übertragen (keep false), Frist auf jetzt
    const last = await offlineShare(h.db, jana, privat, { deviceId: DEV2, sessionId: "s2" }, after(1));
    expect(last).toMatchObject({ keep: false, reason: "privatgeraet", share: first!.share, expiresAt: after(1) });
    // G5A-C04: ein weiterer Abruf (z. B. nach einem Konflikt in einem anderen Buch) bekommt ihn bis zum nächtlichen Lauf weiter
    expect(await offlineShare(h.db, jana, intern, { deviceId: DEV2, sessionId: "s2" }, after(1.01))).toMatchObject({ keep: false, share: first!.share });
    const logs = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "notenbuch.offline.aus"), eq(auditLog.target, DEV2)));
    expect(logs).toHaveLength(1);
    expect(await purgeExpiredOfflineDevices(h.db, after(1.02))).toBe(1);
    expect(await offlineShare(h.db, jana, intern, { deviceId: DEV2, sessionId: "s2" }, after(1.03))).toBeNull();
  });

  it("G5A-S05: eine fremde Gerätekennung lässt sich nicht übernehmen", async () => {
    await expect(activateOfflineDevice(h.db, await p(MURAT), intern, { deviceId: DEV, sessionId: "s3", confirmed: true }, T0)).rejects.toMatchObject({
      fieldErrors: { deviceId: expect.any(String) },
    });
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toEqual([
      expect.objectContaining({ userId: JANA }),
    ]);
  });

  it("G5A-C05: mit Gerätezertifikat eingeschaltet → bleibt im Schulnetz eingeschaltet (Vorgabe „zertifikat“); „Schulnetz“-Geräte nicht", async () => {
    const jana = await p(JANA);
    await writeModuleSetting(h.db, OFFLINE, "zertifikat");
    try {
      // DEV wurde von außen mit Gerätezertifikat eingeschaltet
      expect((await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV)))[0]!.reason).toBe("zertifikat");
      expect(await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s2" }, after(2))).toMatchObject({ keep: true, reason: "kein-zertifikat" });
      // ein im Schulnetz (Einstellung „Schulnetz“) eingeschaltetes Gerät verliert die Erlaubnis, wenn die Schule zurückstellt
      await writeModuleSetting(h.db, OFFLINE, "schulnetz");
      await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV2, sessionId: "s2", confirmed: true }, after(2));
      await writeModuleSetting(h.db, OFFLINE, "zertifikat");
      expect(await offlineShare(h.db, jana, intern, { deviceId: DEV2, sessionId: "s2" }, after(2))).toMatchObject({ keep: false, reason: "kein-zertifikat" });
      // von außen ohne Zertifikat (Privatgerät) auch für Zertifikats-Geräte nie
      expect(await offlineShare(h.db, jana, privat, { deviceId: DEV, sessionId: "s2" }, after(2))).toMatchObject({ keep: false, reason: "privatgeraet" });
    } finally {
      await writeModuleSetting(h.db, OFFLINE, "schulnetz");
      await h.db.delete(notenbuchOfflineDevices);
    }
  });

  it("Frist abgelaufen → nur noch zum Übertragen (keep false), der nächtliche Lauf (G5A-S06) löscht abgelaufene Zeilen", async () => {
    const jana = await p(JANA);
    await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s1", confirmed: true }, T0);
    expect((await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s1" }, after(OFFLINE_MAX_DAYS - 0.5)))!.keep).toBe(true);
    const r = await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s1" }, after(OFFLINE_MAX_DAYS));
    expect(r!.keep).toBe(false);
    expect((await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s1" }, after(OFFLINE_MAX_DAYS)))!.keep).toBe(false);
    const job = SCHEDULED_JOBS.find((j) => j.name === "notenbuch-offline-frist")!;
    expect(job).toBeDefined();
    await job.run(h.db, after(OFFLINE_MAX_DAYS + 0.1));
    expect(await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s1" }, after(OFFLINE_MAX_DAYS + 0.2))).toBeNull();
    await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s1", confirmed: true }, T0);
    expect(await purgeExpiredOfflineDevices(h.db, after(OFFLINE_MAX_DAYS + 1))).toBe(1);
    expect(await purgeExpiredOfflineDevices(h.db, after(OFFLINE_MAX_DAYS + 1))).toBe(0);
  });

  it("Abmelden (Sitzung gelöscht) und Rechteentzug nehmen den Anteil mit; Ausschalten durch die Person selbst", async () => {
    const jana = await p(JANA);
    await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s1", confirmed: true }, T0);
    // G5A-C01: Sitzung weg (z. B. Neuanmeldung nach der 15-Minuten-Sperre) → der Anteil bleibt, nur ohne Sitzung
    await h.db.delete(sessions).where(eq(sessions.id, "s1"));
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toEqual([
      expect.objectContaining({ userId: JANA, sessionId: null }),
    ]);
    await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s2", confirmed: true }, T0);
    // Recht `notenbuch.own` entzogen → Abruf null, Zeile weg
    const [g] = await h.db
      .select()
      .from(grants)
      .where(and(eq(grants.role, "lehrkraft"), eq(grants.permission, "notenbuch.own")));
    await h.db.delete(grants).where(eq(grants.id, g!.id));
    expect(await offlineShare(h.db, await p(JANA), intern, { deviceId: DEV, sessionId: "s2" }, T0)).toBeNull();
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toEqual([]);
    await h.db.insert(grants).values({ role: "lehrkraft", permission: "notenbuch.own" });
    await activateOfflineDevice(h.db, await p(JANA), intern, { deviceId: DEV, sessionId: "s2", confirmed: true }, T0);
    // eine andere Person kann das Gerät nicht ausschalten, die eigene schon
    await deactivateOfflineDevice(h.db, await p(MURAT), DEV);
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toHaveLength(1);
    await deactivateOfflineDevice(h.db, await p(JANA), DEV);
    expect(await h.db.select().from(notenbuchOfflineDevices).where(eq(notenbuchOfflineDevices.deviceId, DEV))).toEqual([]);
  });

  it("G5A-C01: Neuanmeldung nach der 15-Minuten-Sperre bindet neu, echtes Abmelden (nur diese Sitzung) beendet; Auskunft ohne Anteil (G5A-S07)", async () => {
    const jana = await p(JANA);
    await h.db.insert(sessions).values([
      { id: "s-alt", token: "t-s-alt", userId: JANA, expiresAt: after(7) },
      { id: "s-neu", token: "t-s-neu", userId: JANA, expiresAt: after(7) },
    ]);
    const on = await activateOfflineDevice(h.db, jana, intern, { deviceId: DEV, sessionId: "s-alt", confirmed: true }, T0);
    // Sperre → „Neu anmelden“: Better Auth löscht die alte Sitzung
    await h.db.delete(sessions).where(eq(sessions.id, "s-alt"));
    const again = await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s-neu" }, after(0.1));
    expect(again).toMatchObject({ keep: true, share: on.share });
    // die Warteschlange lässt sich danach übertragen
    const [r] = await syncOfflineOps(h.db, jana, bookId, [op({ columnId: col, studentId: other, value: "befreit", baseVersion: 0 })], DEV, after(0.1));
    expect(r!.status).toBe("applied");
    await h.db.delete(notenbuchEntries).where(and(eq(notenbuchEntries.columnId, col), eq(notenbuchEntries.studentId, other)));
    // Auskunft der Lehrkraft: Gerät ja, Schlüsselanteil und Sitzung nein
    const data = (await collectPersonalData(h.db, JANA))!;
    const devices = data.sections.find((s) => s.table === "notenbuch_offline_devices")!;
    expect(devices.rows).toHaveLength(1);
    expect(devices.rows[0]).not.toHaveProperty("server_share");
    expect(devices.rows[0]).not.toHaveProperty("session_id");
    expect(JSON.stringify(data)).not.toContain(on.share);
    // echtes Abmelden einer anderen Sitzung lässt das Gerät stehen, das der gebundenen Sitzung beendet es
    expect(await endOfflineForSession(h.db, JANA, "s1")).toBe(0);
    expect(await endOfflineForSession(h.db, MURAT, "s-neu")).toBe(0);
    expect(await endOfflineForSession(h.db, JANA, "s-neu")).toBe(1);
    expect(await offlineShare(h.db, jana, intern, { deviceId: DEV, sessionId: "s-neu" }, after(0.2))).toBeNull();
  });

  it("Abgleich: anwenden (Spuren wie online), Wiederholung idempotent, Konflikt mit Server-Wert und Name, Löschen", async () => {
    const jana = await p(JANA);
    const a = op({ columnId: col, studentId: lea, value: "2", comment: "gut" });
    const b = op({ columnId: col, studentId: other, value: "fehlt" });
    const r1 = await syncOfflineOps(h.db, jana, bookId, [a, b], DEV, after(1));
    expect(r1).toEqual([
      { opId: a.opId, status: "applied", version: expect.any(Number) },
      { opId: b.opId, status: "applied", version: expect.any(Number) },
    ]);
    const va = (r1[0] as { version: number }).version;
    const vb = (r1[1] as { version: number }).version;
    const [cell] = await h.db
      .select()
      .from(notenbuchEntries)
      .where(and(eq(notenbuchEntries.columnId, col), eq(notenbuchEntries.studentId, lea)));
    expect(cell).toMatchObject({ value: "2", comment: "gut", version: va, updatedBy: JANA });
    expect(cell!.updatedAt).toEqual(after(1));
    // dieselben Änderungen noch einmal (Antwort war verloren): schon angewendet, nichts verändert
    const r2 = await syncOfflineOps(h.db, jana, bookId, [a, b], DEV, after(1.1));
    expect(r2.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect((await h.db.select().from(notenbuchEntries).where(eq(notenbuchEntries.columnId, col))).map((e) => e.version).sort()).toEqual([va, vb].sort());
    // Tobias ändert online → Offline-Änderung auf alter Revision kollidiert, nichts überschrieben
    const vt = await setEntry(h.db, await p(TOBIAS), { columnId: col, studentId: lea, value: "4", expectedVersion: va }, after(1.2));
    const c = op({ columnId: col, studentId: lea, value: "3", baseVersion: va });
    const [r3] = await syncOfflineOps(h.db, jana, bookId, [c], DEV, after(1.3));
    expect(r3).toEqual({ opId: c.opId, status: "conflict", server: { value: "4", comment: null, version: vt }, serverLabel: "Tobias Kleine" });
    expect(
      (
        await h.db
          .select()
          .from(notenbuchEntries)
          .where(and(eq(notenbuchEntries.columnId, col), eq(notenbuchEntries.studentId, lea)))
      )[0]!.value,
    ).toBe("4");
    // bewusst „meine Eingabe“: auf die Server-Revision neu aufgesetzt → angewendet
    const [r4] = await syncOfflineOps(h.db, jana, bookId, [{ ...c, opId: crypto.randomUUID(), baseVersion: vt }], DEV, after(1.4));
    expect(r4).toMatchObject({ status: "applied" });
    const v4 = (r4 as { version: number }).version;
    expect(v4).toBeGreaterThan(vt);
    // Löschen offline
    const d = op({ columnId: col, studentId: other, value: "", baseVersion: vb });
    const [r5] = await syncOfflineOps(h.db, jana, bookId, [d], DEV, after(1.5));
    expect(r5).toMatchObject({ status: "applied", version: 0 });
    expect(
      await h.db
        .select()
        .from(notenbuchEntries)
        .where(and(eq(notenbuchEntries.columnId, col), eq(notenbuchEntries.studentId, other))),
    ).toEqual([]);
    // ungültiger Wert und unbekannte Spalte → abgelehnt, fremdes Buch → ForbiddenError, Audit mit Zahlen
    const bad = op({ columnId: col, studentId: lea, value: "9", baseVersion: v4 });
    const gone = op({ columnId: "spalte-weg", studentId: lea, value: "1" });
    const r6 = await syncOfflineOps(h.db, jana, bookId, [bad, gone], DEV, after(1.6));
    expect(r6.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await expect(syncOfflineOps(h.db, await p(MURAT), bookId, [a], null, after(1.7))).rejects.toThrow(ForbiddenError);
    const [log] = await h.db.select().from(auditLog).where(eq(auditLog.action, "notenbuch.offline.abgleich")).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(log!.meta).toMatchObject({ geraet: DEV, angewendet: 0, konflikte: 0, abgelehnt: 2 });
    expect(JSON.stringify(log!.meta)).not.toContain('"9"');
  });

  it("abgeschlossenes Buch lehnt jede Offline-Änderung ab", async () => {
    const jana = await p(JANA);
    const view = (await getBook(h.db, jana, bookId))!;
    for (const s of view.students) await setFinalGrade(h.db, jana, bookId, s.id, "3", after(2));
    await lockBook(h.db, jana, bookId, after(2));
    const x = op({ columnId: col, studentId: lea, value: "1", baseVersion: 3 });
    const [r] = await syncOfflineOps(h.db, jana, bookId, [x], DEV, after(2.1));
    expect(r).toMatchObject({ status: "rejected", reason: expect.stringContaining("gesperrt") });
    expect(
      (
        await h.db
          .select()
          .from(notenbuchEntries)
          .where(and(eq(notenbuchEntries.columnId, col), eq(notenbuchEntries.studentId, lea)))
      )[0]!.value,
    ).toBe("3");
    expect((await h.db.select().from(notenbuchBooks).where(eq(notenbuchBooks.id, bookId)))[0]!.lockedAt).not.toBeNull();
  });

  it("parseOp: nur wohlgeformte Änderungen (Kennung, Revision), Typen erzwungen", () => {
    expect(parseOp(null)).toBeNull();
    expect(parseOp({ opId: "x", columnId: "c", studentId: "s", value: "1", baseVersion: 0 })).toBeNull();
    expect(parseOp({ opId: crypto.randomUUID(), columnId: "c", studentId: "s", value: "1", baseVersion: -1 })).toBeNull();
    const id = crypto.randomUUID();
    expect(parseOp({ opId: id, columnId: 5, studentId: "s", value: 2, comment: undefined, baseVersion: "3", at: 1 })).toEqual({
      opId: id,
      columnId: "5",
      studentId: "s",
      value: "2",
      comment: null,
      baseVersion: 3,
      at: "1",
    });
  });
});
