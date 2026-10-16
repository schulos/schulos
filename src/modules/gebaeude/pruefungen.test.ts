import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { MailMessage } from "@schulos/server/mail";
import type { DbHandle } from "@/core/db/client";
import { auditLog, calendarEvents, gebaeudeAssets, gebaeudeInspections, gebaeudeInspectionTypes, gebaeudeTickets, notifications, timetableRoomBlocks } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { setModuleEnabled } from "@/core/modules/registry";
import { SCHEDULED_JOBS } from "@/core/scheduler";
import manifest from "./manifest";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { PNG } from "@/core/images.fixtures";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { collectPersonalData } from "@/core/privacy/auskunft";
import { referencedStorageKeys } from "@/core/privacy/dateispeicher";
import { addDays, toBerlinDate } from "@/core/time";
import { listSlots } from "@/modules/stundenplan/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { INSPECTION_TEMPLATE } from "./pruefarten";
import {
  addMonths,
  cancelInspection,
  checklist,
  createAsset,
  defectTicket,
  ensureTemplate,
  importAssets,
  inspectionState,
  inspectionSummary,
  inspectionsCsv,
  isPdf,
  lastMonths,
  listAssets,
  listInspections,
  listInspectionTypes,
  overdueMessage,
  parseAssetCsv,
  parseDay,
  planInspection,
  recordInspection,
  reminderDue,
  reportFor,
  runInspectionReminders,
  ticketsCsv,
  ticketStats,
  updateInspectionType,
} from "./pruefungen";
import { createTicket } from "./service";
import { createMaintenance, deleteMaintenance, listMaintenance, maintenanceSpan } from "./wartung";

const JANA = "u-jana.brandt";
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.manage, nicht configure
const SABINE = "u-sabine.kowalski"; // Verwaltung: manage + configure + view_all
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

describe("Prüffristen (rein)", () => {
  it("Monate addieren: Monatsende und Schaltjahr", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2024-02-29", 48)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-15", -13)).toBe("2024-12-15");
    expect(addMonths("2026-10-10", 24)).toBe("2028-10-10");
  });

  it("Stand: überfällig ab dem Tag nach dem Termin, bald fällig in der Vorwarnzeit (einschließlich)", () => {
    const today = "2026-10-10";
    expect(inspectionState({ dueOn: "2026-10-09", doneOn: null }, 30, today)).toBe("ueberfaellig");
    expect(inspectionState({ dueOn: "2026-10-10", doneOn: null }, 30, today)).toBe("faellig");
    expect(inspectionState({ dueOn: "2026-11-09", doneOn: null }, 30, today)).toBe("faellig");
    expect(inspectionState({ dueOn: "2026-11-10", doneOn: null }, 30, today)).toBe("geplant");
    expect(inspectionState({ dueOn: "2026-10-12", doneOn: null }, 0, today)).toBe("geplant");
    expect(inspectionState({ dueOn: "2020-01-01", doneOn: "2020-01-02" }, 30, today)).toBe("erledigt");
  });

  it("Erinnerung: bald fällig einmal je Woche, überfällig einmal je Kalendertag", () => {
    const now = new Date("2026-10-10T02:00:00Z"); // 04:00 Berlin
    expect(reminderDue("faellig", null, now)).toBe(true);
    expect(reminderDue("faellig", new Date("2026-10-05T02:00:00Z"), now)).toBe(false);
    expect(reminderDue("faellig", new Date("2026-10-03T02:05:00Z"), now)).toBe(true); // Lauf einige Minuten später als letzte Woche
    expect(reminderDue("ueberfaellig", new Date("2026-10-09T02:00:00Z"), now)).toBe(true);
    expect(reminderDue("ueberfaellig", new Date("2026-10-10T01:00:00Z"), now)).toBe(false);
    expect(reminderDue("geplant", null, now)).toBe(false);
  });

  it("PDF nur an den Magic Bytes erkannt", () => {
    expect(isPdf(PDF)).toBe(true);
    expect(isPdf(PNG)).toBe(false);
    expect(isPdf(new TextEncoder().encode("<html>%PDF-"))).toBe(false);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
  });

  it("CSV der Inventarliste: mit/ohne Kopfzeile, „;“ oder „,“, Arten als Beschriftung oder Kurzform, Datumsformate", () => {
    const a = parseAssetCsv("﻿Name;Art;Raum;Inventarnummer;letzte Prüfung\nFeuerlöscher A;Feuerlöscher;106;FL-9;01.03.2025\nLeiter;leiter;;LE-9;\n");
    expect(a.errors).toEqual([]);
    expect(a.rows).toEqual([
      { line: 2, name: "Feuerlöscher A", kind: "feuerloescher", roomId: "106", inventoryNo: "FL-9", lastInspected: "2025-03-01" },
      { line: 3, name: "Leiter", kind: "leiter", roomId: null, inventoryNo: "LE-9", lastInspected: null },
    ]);
    const b = parseAssetCsv('Beamer 106,Elektro,106,"EL,1"\nX,Rakete,,\n,leiter,,\nWaage,sonstiges,,,32.13.2025');
    expect(b.rows.map((r) => [r.name, r.kind, r.inventoryNo])).toEqual([["Beamer 106", "elektro_ortsveraenderlich", "EL,1"]]);
    expect(b.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(parseDay("2025-03-01")).toBe("2025-03-01");
    expect(parseDay("1.3.2025")).toBe("2025-03-01");
    expect(parseDay("30.02.2025")).toBeNull();
    expect(parseDay("2025-13-01")).toBeNull();
  });

  it("Mangel → Meldung: Kategorie nach Anlagen-Art, „außer Betrieb“ mit hoher Priorität", () => {
    expect(defectTicket({ typeName: "Feuerlöscher", target: "FL-1", assetKind: "feuerloescher" }, "mangel")).toEqual({
      category: "sicherheit",
      priority: "normal",
      title: "Prüfung Feuerlöscher: Mangel – FL-1",
    });
    expect(defectTicket({ typeName: "Aufzüge", target: "Aufzug", assetKind: "aufzug" }, "ausser_betrieb")).toMatchObject({ category: "technik", priority: "hoch" });
    expect(defectTicket({ typeName: "Trinkwasser", target: "Hauptgebäude", assetKind: null }, "mangel").category).toBe("gebaeude");
  });

  it("Vorlage: zwölf Prüfarten, jede Quelle „zu prüfen“; Alarm-Mail ohne Personen; Monate für die Statistik", () => {
    expect(INSPECTION_TEMPLATE).toHaveLength(12);
    expect(new Set(INSPECTION_TEMPLATE.map((t) => t.key)).size).toBe(12);
    for (const t of INSPECTION_TEMPLATE) {
      expect(t.source).toMatch(/zu prüfen$/);
      expect(t.intervalMonths).toBeGreaterThan(0);
      expect(t.assetKind === null || t.appliesTo === "anlage").toBe(true);
    }
    const m = overdueMessage("SchulOS Test", ["alarm@example.org"], [{ typeName: "Leitern", target: "Stehleiter (LE-1)", building: "Sporthalle", dueOn: "2026-09-20" }]);
    expect(m.subject).toBe("[SchulOS Test] 1 Prüfung überfällig");
    expect(m.text).toContain("Leitern: Stehleiter (LE-1) (Sporthalle), fällig seit 20.09.2026");
    expect(lastMonths("2026-03-31", 4)).toEqual(["2026-03", "2026-02", "2026-01", "2025-12"]);
    expect(maintenanceSpan(new Date("2026-10-12T06:00:00Z"), new Date("2026-10-12T10:00:00Z"))).toBe("Mo., 12.10., 08:00–12:00");
  });
});

describe("Anlagen, Prüfungen, Wartung – Service", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const gongs = async (userId: string) => (await h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "gebaeude")))).map((n) => n.title);

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-pruefungen-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Rechte: Lehrkräfte sehen weder Anlagen noch Prüfungen; Hausmeisterei erfasst, konfiguriert aber nicht; Verwaltung konfiguriert", async () => {
    const [jana, klaus, sabine] = await Promise.all([p(JANA), p(KLAUS), p(SABINE)]);
    await expect(listInspections(h.db, jana, {}, today)).rejects.toThrow(ForbiddenError);
    await expect(listAssets(h.db, jana)).rejects.toThrow(ForbiddenError);
    await expect(ticketsCsv(h.db, jana)).rejects.toThrow(ForbiddenError);
    expect(await listInspections(h.db, klaus, {}, today)).not.toHaveLength(0);
    await expect(createAsset(h.db, klaus, { name: "Leiter", kind: "leiter", roomId: null, building: null, inventoryNo: null }, today)).rejects.toThrow(ForbiddenError);
    const [t] = await listInspectionTypes(h.db);
    await expect(updateInspectionType(h.db, klaus, t!.id, { ...t!, active: false }, today)).rejects.toThrow(ForbiddenError);
    await expect(planInspection(h.db, jana, { typeId: t!.id, dueOn: today })).rejects.toThrow(ForbiddenError);
    expect(await listAssets(h.db, sabine)).not.toHaveLength(0);
  });

  it("Vorlage idempotent; Demo: Leiter überfällig, Feuerlöscher in 14 Tagen fällig, Lüftung ohne Prüfart ohne Prüfung", async () => {
    await ensureTemplate(h.db);
    const types = await listInspectionTypes(h.db);
    expect(types.filter((t) => t.templateKey)).toHaveLength(12);
    const sabine = await p(SABINE);
    const open = await listInspections(h.db, sabine, { state: "offen" }, today);
    const ladder = open.find((r) => r.assetName === "Stehleiter 6 Stufen")!;
    expect(ladder.state).toBe("ueberfaellig");
    expect(ladder.dueOn).toBe(addDays(today, -20));
    const ext = open.find((r) => r.assetName === "Feuerlöscher Flur EG")!;
    expect(ext).toMatchObject({ state: "faellig", dueOn: addDays(today, 14), building: "Hauptgebäude" });
    expect((await listInspections(h.db, sabine, { state: "ueberfaellig" }, today)).map((r) => r.target)).toEqual(["Stehleiter 6 Stufen (LE-001)"]);
    expect(open.some((r) => r.assetName === "Lüftungsanlage Pavillon")).toBe(false);
  });

  it("Anlage anlegen plant passende Prüfungen: Anschaffung + Intervall, ohne Datum sofort; außer Betrieb streicht offene", async () => {
    const sabine = await p(SABINE);
    const id = await createAsset(h.db, sabine, { name: "Feuerlöscher Mensa", kind: "feuerloescher", roomId: null, building: "Pavillon", inventoryNo: "FL-100", acquiredOn: "2026-01-31" }, today);
    const id2 = await createAsset(h.db, sabine, { name: "Leiter Lager", kind: "leiter", roomId: "106", building: null, inventoryNo: "LE-100" }, today);
    const due = async (assetId: string) =>
      (await h.db.select().from(gebaeudeInspections).where(and(eq(gebaeudeInspections.assetId, assetId), isNull(gebaeudeInspections.doneOn)))).map((i) => i.dueOn);
    expect(await due(id)).toEqual(["2028-01-31"]);
    expect(await due(id2)).toEqual([today]);
    expect(await fieldErrors(createAsset(h.db, sabine, { name: "Doppelt", kind: "leiter", roomId: "gibtsnicht", building: null, inventoryNo: "FL-100" }, today))).toMatchObject({
      roomId: expect.any(String),
      inventoryNo: "Inventarnummer ist schon vergeben",
    });
    const { setAssetActive } = await import("./pruefungen");
    await setAssetActive(h.db, sabine, id2, false, today);
    expect(await due(id2)).toEqual([]);
    expect((await listAssets(h.db, sabine)).some((a) => a.id === id2)).toBe(false);
  });

  it("Prüfart einschalten/anpassen plant nach; ausgeschaltete Prüfarten ruhen", async () => {
    const sabine = await p(SABINE);
    const types = await listInspectionTypes(h.db);
    const lift = types.find((t) => t.templateKey === "aufzuege")!;
    await h.db.insert(gebaeudeAssets).values({ name: "Aufzug Hauptgebäude", kind: "aufzug", building: "Hauptgebäude", inventoryNo: "AZ-1" });
    expect((await listInspections(h.db, sabine, { typeId: lift.id }, today)).length).toBe(0);
    await updateInspectionType(h.db, sabine, lift.id, { ...lift, active: true, intervalMonths: 24 }, today);
    expect(await listInspections(h.db, sabine, { typeId: lift.id }, today)).toMatchObject([{ dueOn: today, state: "faellig" }]);
    await updateInspectionType(h.db, sabine, lift.id, { ...lift, active: false }, today);
    expect(await listInspections(h.db, sabine, { typeId: lift.id }, today)).toHaveLength(0);
    expect(await fieldErrors(updateInspectionType(h.db, sabine, lift.id, { ...lift, appliesTo: "gebaeude", intervalMonths: 0 }, today))).toMatchObject({
      intervalMonths: expect.any(String),
    });
  });

  it("Erfassen: ok → nächste Prüfung (Prüfdatum + Intervall); Protokoll nur als PDF, Auslieferung nur für Bearbeitung/Leitung", async () => {
    const [klaus, jana, sabine] = await Promise.all([p(KLAUS), p(JANA), p(SABINE)]);
    const ext = (await listInspections(h.db, klaus, { state: "offen" }, today)).find((r) => r.assetName === "Feuerlöscher Flur EG")!;
    expect(await fieldErrors(recordInspection(h.db, storage, klaus, ext.id, { doneOn: today, result: "ok", company: null, note: null, report: PNG }, { today }))).toEqual({
      report: "Protokoll nur als PDF",
    });
    expect(await fieldErrors(recordInspection(h.db, storage, klaus, ext.id, { doneOn: addDays(today, 1), result: "gut", company: null, note: null }, { today }))).toMatchObject({
      doneOn: expect.any(String),
      result: expect.any(String),
    });
    await expect(recordInspection(h.db, storage, jana, ext.id, { doneOn: today, result: "ok", company: null, note: null }, { today })).rejects.toThrow(ForbiddenError);
    const r = await recordInspection(h.db, storage, klaus, ext.id, { doneOn: today, result: "ok", company: "Brandschutz Muster GmbH", note: null, report: PDF }, { today });
    expect(r.ticketId).toBeNull();
    const [next] = await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.id, r.nextId!));
    expect(next!.dueOn).toBe(addMonths(today, 24));
    // Protokoll: im Dateispeicher, vom Aufräumlauf geschützt, nur für Berechtigte
    const report = await reportFor(h.db, sabine, ext.id);
    expect(report?.size).toBe(PDF.length);
    expect(new Uint8Array(await new Response((await storage.get(report!.key))!).arrayBuffer())).toEqual(PDF);
    expect((await referencedStorageKeys(h.db)).has(report!.key)).toBe(true);
    expect(await reportFor(h.db, jana, ext.id)).toBeNull();
    expect(await fieldErrors(recordInspection(h.db, storage, klaus, ext.id, { doneOn: today, result: "ok", company: null, note: null }, { today }))).toEqual({
      inspection: "Prüfung ist schon erfasst",
    });
    // kein Personenbezug in der Prüfung, Erfassung im Audit-Log
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "gebaeude.inspection.record"), eq(auditLog.target, ext.id)));
    expect(audit?.actorId).toBe(KLAUS);
  });

  it("Mangel → Meldung mit Gong an die Zuständigen; Prüfliste zeigt letzte Prüfung und nächste Fälligkeit", async () => {
    const klaus = await p(KLAUS);
    const ladder = (await listInspections(h.db, klaus, { state: "ueberfaellig" }, today))[0]!;
    const r = await recordInspection(h.db, storage, klaus, ladder.id, { doneOn: today, result: "mangel", company: "Hausmeisterei", note: "Sprosse 3 locker" }, { today });
    const [t] = await h.db.select().from(gebaeudeTickets).where(eq(gebaeudeTickets.id, r.ticketId!));
    expect(t).toMatchObject({ category: "gebaeude", priority: "normal", title: "Prüfung Leitern und Tritte: Mangel – Stehleiter 6 Stufen (LE-001)", location: "Sporthalle" });
    expect(t!.description).toContain("Sprosse 3 locker");
    const rows = await checklist(h.db, klaus, { building: "Sporthalle" }, today);
    const row = rows.find((x) => x.target === "Stehleiter 6 Stufen (LE-001)")!;
    expect(row.last).toMatchObject({ doneOn: today, result: "mangel", company: "Hausmeisterei", ticketId: r.ticketId });
    expect(row.next).toEqual({ dueOn: addMonths(today, 12), state: "geplant" });
    expect(rows.every((x) => x.building === "Sporthalle")).toBe(true);
  });

  it("Gebäudeprüfung planen: Ziel passend zur Prüfart, keine doppelte offene Prüfung", async () => {
    const klaus = await p(KLAUS);
    const types = await listInspectionTypes(h.db, { activeOnly: true });
    const walk = types.find((t) => t.templateKey === "begehung-arbeitsschutz")!;
    expect(await fieldErrors(planInspection(h.db, klaus, { typeId: walk.id, dueOn: today }))).toEqual({ building: "Gebäude angeben" });
    await planInspection(h.db, klaus, { typeId: walk.id, building: "Pavillon", dueOn: addDays(today, 100) });
    expect(await fieldErrors(planInspection(h.db, klaus, { typeId: walk.id, building: "Pavillon", dueOn: today }))).toEqual({ dueOn: "Diese Prüfung ist schon geplant" });
    const ladderType = types.find((t) => t.templateKey === "leitern")!;
    const [ext] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "FL-002"));
    expect(await fieldErrors(planInspection(h.db, klaus, { typeId: ladderType.id, assetId: ext!.id, dueOn: today }))).toEqual({ assetId: "Prüfart gilt für Leiter/Tritt" });
  });

  it("Fristen-Job: Gong an alle mit „manage“, überfällig täglich + Alarm-Mail ohne Namen, bald fällig nur wöchentlich", async () => {
    const sabine = await p(SABINE);
    const types = await listInspectionTypes(h.db, { activeOnly: true });
    const kit = types.find((t) => t.templateKey === "erste-hilfe")!;
    // eine überfällige und eine in 14 Tagen fällige Prüfung (Vorwarnzeit 30 Tage)
    await planInspection(h.db, sabine, { typeId: types.find((t) => t.templateKey === "brandschutz-technik")!.id, building: "Sporthalle", dueOn: addDays(today, -3) });
    const [kitAsset] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "EH-001"));
    await h.db
      .update(gebaeudeInspections)
      .set({ dueOn: addDays(today, 14) })
      .where(and(eq(gebaeudeInspections.assetId, kitAsset!.id), eq(gebaeudeInspections.typeId, kit.id), isNull(gebaeudeInspections.doneOn)));
    const mails: MailMessage[] = [];
    const mail = { config: { host: "smtp.example.org", port: 587, secure: false, user: null, password: null, from: "schulos@example.org", to: ["alarm@example.org"] }, sender: async (m: MailMessage) => void mails.push(m), server: "SchulOS Test" };
    const now = new Date();
    const before = (await gongs(KLAUS)).length;
    const r1 = await runInspectionReminders(h.db, { now, mail });
    expect(r1.overdue).toBeGreaterThanOrEqual(1);
    expect(r1.due).toBeGreaterThanOrEqual(1);
    expect(r1.mailed).toBe(true);
    const klausGongs = await gongs(KLAUS);
    expect(klausGongs.length).toBe(before + 1);
    expect(klausGongs.at(-1)).toMatch(/^Prüfungen: \d+ überfällig, \d+ bald fällig$/);
    expect(await gongs(JANA)).not.toContainEqual(expect.stringMatching(/^Prüfungen/));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("Brandmeldeanlage");
    expect(mails[0]!.text).not.toMatch(/Klaus|Berger|Sabine|Kowalski/);
    // derselbe Tag: nichts Neues
    expect(await runInspectionReminders(h.db, { now: new Date(now.getTime() + 60_000), mail })).toMatchObject({ overdue: 0, due: 0, notified: 0, mailed: false });
    // nächster Tag: überfällige erneut, bald fällige erst nach einer Woche
    const r3 = await runInspectionReminders(h.db, { now: new Date(now.getTime() + 86_400_000), mail });
    expect(r3).toMatchObject({ due: 0, mailed: true });
    expect(r3.overdue).toBeGreaterThanOrEqual(1);
    const r4 = await runInspectionReminders(h.db, { now: new Date(now.getTime() + 7 * 86_400_000), mail });
    expect(r4.due).toBeGreaterThanOrEqual(1);
    // ohne SMTP: Gong ja, Mail nein
    const r5 = await runInspectionReminders(h.db, { now: new Date(now.getTime() + 8 * 86_400_000) });
    expect(r5).toMatchObject({ mailed: false });
  });

  it("CSV-Import: alles oder nichts, gleiche Inventarnummer aktualisiert, „letzte Prüfung“ als übernommener Nachweis", async () => {
    const [sabine, klaus] = await Promise.all([p(SABINE), p(KLAUS)]);
    await expect(importAssets(h.db, klaus, "a;leiter;;", today)).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(importAssets(h.db, sabine, "Name;Art;Raum;Inventarnummer\nLeiter A;leiter;999;LE-200\nLeiter B;leiter;;LE-200\n", today))).toEqual({
      file: "Zeile 2: Raum „999“ gibt es nicht · Zeile 3: Inventarnummer „LE-200“ doppelt",
    });
    expect(await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "LE-200"))).toHaveLength(0);
    const lastYear = addMonths(today, -11);
    const csv = `Name;Art;Raum;Inventarnummer;letzte Prüfung\nLeiter A;Leiter;106;LE-200;${lastYear}\nFeuerlöscher Chemie (neu);Feuerlöscher;NW2;FL-002;\n`;
    expect(await importAssets(h.db, sabine, csv, today)).toEqual({ created: 1, updated: 1 });
    const [a] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "LE-200"));
    const insp = await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.assetId, a!.id));
    expect(insp.map((i) => [i.doneOn, i.result, i.dueOn]).sort((x, y) => String(x[2]).localeCompare(String(y[2])))).toEqual([
      [lastYear, null, lastYear],
      [null, null, addMonths(lastYear, 12)],
    ]);
    const [b] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "FL-002"));
    expect(b!.name).toBe("Feuerlöscher Chemie (neu)");
  });

  it("CSV-Import erneut mit „letzte Prüfung“: offene Prüfung rückt nach, Nachweis nicht doppelt (Code-Review Gate 4a M1)", async () => {
    const sabine = await p(SABINE);
    await importAssets(h.db, sabine, "Name;Art;Raum;Inventarnummer\nLeiter C;Leiter;106;LE-300\n", today);
    const [a] = await h.db.select().from(gebaeudeAssets).where(eq(gebaeudeAssets.inventoryNo, "LE-300"));
    const state = async () =>
      (await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.assetId, a!.id))).map((i) => [i.doneOn, i.dueOn]).sort((x, y) => String(x[1]).localeCompare(String(y[1])));
    expect(await state()).toEqual([[null, today]]);
    const last = addMonths(today, -2);
    const again = `Name;Art;Raum;Inventarnummer;letzte Prüfung\nLeiter C;Leiter;106;LE-300;${last}\n`;
    expect(await importAssets(h.db, sabine, again, today)).toEqual({ created: 0, updated: 1 });
    expect(await state()).toEqual([
      [last, last],
      [null, addMonths(last, 12)],
    ]);
    await importAssets(h.db, sabine, again, today);
    expect(await state()).toEqual([
      [last, last],
      [null, addMonths(last, 12)],
    ]);
    // Fehler mitten im Schreiben: nichts bleibt (Transaktion)
    const sabineCount = (await h.db.select().from(gebaeudeAssets)).length;
    await expect(importAssets(h.db, sabine, "Leiter X;Leiter;106;LE-301\nLeiter Y;Leiter;106;" + "x".repeat(41) + "\n", today)).rejects.toThrow(ValidationError);
    expect((await h.db.select().from(gebaeudeAssets)).length).toBe(sabineCount);
  });

  it("Erfassen ist atomar: doppeltes Absenden legt keine zweite Meldung und Folgeprüfung an (Code-Review Gate 4a N2)", async () => {
    const [klaus, sabine] = await Promise.all([p(KLAUS), p(SABINE)]);
    const types = await listInspectionTypes(h.db, { activeOnly: true });
    const walk = types.find((t) => t.templateKey === "begehung-arbeitsschutz")!;
    const id = await planInspection(h.db, sabine, { typeId: walk.id, building: "Doppelhaus", dueOn: today });
    const input = { doneOn: today, result: "mangel", company: null, note: "Fluchtweg zugestellt" };
    const results = await Promise.allSettled([recordInspection(h.db, storage, klaus, id, input, { today }), recordInspection(h.db, storage, klaus, id, input, { today })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const tickets = await h.db.select().from(gebaeudeTickets).where(eq(gebaeudeTickets.location, "Doppelhaus"));
    expect(tickets).toHaveLength(1);
    const open = await h.db.select().from(gebaeudeInspections).where(and(eq(gebaeudeInspections.building, "Doppelhaus"), isNull(gebaeudeInspections.doneOn)));
    expect(open).toHaveLength(1);
    const [done] = await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.id, id));
    expect(done!.ticketId).toBe(tickets[0]!.id);
  });

  it("Gestrichene Prüfung einer Anlage plant der Fristen-Job neu; Mail-Fehler bricht die Erinnerung nicht ab (N3, N4)", async () => {
    const [klaus, sabine] = await Promise.all([p(KLAUS), p(SABINE)]);
    const id = await createAsset(h.db, sabine, { name: "Leiter Keller", kind: "leiter", roomId: null, building: "Keller", inventoryNo: "LE-400" }, today);
    const open = async () => (await h.db.select().from(gebaeudeInspections).where(and(eq(gebaeudeInspections.assetId, id), isNull(gebaeudeInspections.doneOn)))).length;
    const [i] = await h.db.select().from(gebaeudeInspections).where(and(eq(gebaeudeInspections.assetId, id), isNull(gebaeudeInspections.doneOn)));
    await cancelInspection(h.db, klaus, i!.id);
    expect(await open()).toBe(0);
    const failing = {
      config: { host: "smtp.example.org", port: 587, secure: false, user: null, password: null, from: "schulos@example.org", to: ["alarm@example.org"] },
      sender: async () => {
        throw new Error("SMTP weg");
      },
    };
    // überfällige Prüfung für die Mail
    await h.db.update(gebaeudeInspections).set({ remindedAt: null }).where(isNull(gebaeudeInspections.doneOn));
    const r = await runInspectionReminders(h.db, { now: new Date(Date.now() + 40 * 86_400_000), mail: failing });
    expect(await open()).toBe(1);
    expect(r.overdue).toBeGreaterThanOrEqual(1);
    expect(r).toMatchObject({ mailed: false, mailError: "SMTP weg" });
    await h.db.update(gebaeudeInspections).set({ remindedAt: null }).where(isNull(gebaeudeInspections.doneOn)); // Zeitsprung zurücknehmen
  });

  it("Wartung: Raumsperre, Schulkalender, Gong an Lehrkräfte des Raums; Absagen räumt auf; nur mit „manage“", async () => {
    const [klaus, jana] = await Promise.all([p(KLAUS), p(JANA)]);
    // ein Tag mit Unterricht in Raum 106 in den nächsten drei Wochen
    const slots = (await listSlots(h.db, { kind: "room", id: "106" }, addDays(today, 1), addDays(today, 22))).filter((s) => s.teacherId && s.teacherId !== KLAUS && !s.change);
    const s = slots[0]!;
    const input = {
      title: "Wartung Beamer",
      provider: "Medientechnik GmbH",
      start: `${s.date}T${s.startsAt.slice(0, 5)}`,
      end: `${s.date}T${s.endsAt.slice(0, 5)}`,
      building: null,
      roomIds: ["106"],
      note: null,
      blockRooms: true,
      calendar: true,
    };
    await expect(createMaintenance(h.db, jana, input)).rejects.toThrow(ForbiddenError);
    expect(await fieldErrors(createMaintenance(h.db, klaus, { ...input, end: input.start, roomIds: ["999"] }))).toMatchObject({ end: expect.any(String), roomIds: expect.any(String) });
    const { id, notified } = await createMaintenance(h.db, klaus, input);
    expect(notified).toBeGreaterThanOrEqual(1);
    expect(await gongs(s.teacherId!)).toContain("Wartung in Raum 106: Wartung Beamer");
    const [m] = await listMaintenance(h.db, klaus, new Date());
    expect(m).toMatchObject({ id, rooms: ["106"], blocked: true, provider: "Medientechnik GmbH" });
    const blocks = await h.db.select().from(timetableRoomBlocks).where(and(eq(timetableRoomBlocks.roomId, "106"), eq(timetableRoomBlocks.startsOn, s.date)));
    expect(blocks.map((b) => b.note)).toContain("Wartung: Wartung Beamer");
    const [ev] = await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, m!.calendarEventId!));
    expect(ev).toMatchObject({ scope: "school", title: "Wartung: Wartung Beamer", location: "Raum 106" });
    await deleteMaintenance(h.db, klaus, id);
    expect(await h.db.select().from(calendarEvents).where(eq(calendarEvents.id, m!.calendarEventId!))).toHaveLength(0);
    expect((await h.db.select().from(timetableRoomBlocks).where(eq(timetableRoomBlocks.note, "Wartung: Wartung Beamer"))).length).toBe(0);
    expect(await listMaintenance(h.db, klaus, new Date())).toHaveLength(0);
  });

  it("CSV-Exporte ohne Personennamen und Freitext, Formeln entschärft; Statistik je Kategorie/Monat", async () => {
    const [jana, sabine] = await Promise.all([p(JANA), p(SABINE)]);
    await createTicket(h.db, storage, jana, { category: "it", priority: "normal", roomId: "106", location: null, title: "=HYPERLINK(\"x\")", description: "Jana Brandt bittet um Rückruf", photos: [] });
    const tickets = await ticketsCsv(h.db, sabine);
    expect(tickets.startsWith("﻿Nummer;Kategorie;Priorität;Status;Ort;Gebäude;Titel;gemeldet am;abgeschlossen am\r\n")).toBe(true);
    expect(tickets).toContain(`"'=HYPERLINK(""x"")"`);
    expect(tickets).not.toMatch(/Jana|Brandt|Klaus|Berger|Rückruf/);
    const checks = await inspectionsCsv(h.db, sabine, today);
    expect(checks.split("\r\n")[0]).toBe("﻿Prüfart;Gegenstand;Inventarnummer;Raum;Gebäude;fällig am;geprüft am;Ergebnis;Firma;Stand;Meldung");
    expect(checks).toContain("Brandschutz Muster GmbH");
    expect(checks).not.toMatch(/Sprosse|Klaus|Berger/);
    const stats = await ticketStats(h.db, sabine, new Date());
    expect(stats.months).toHaveLength(12);
    expect(stats.months[0]!.counts.it).toBeGreaterThanOrEqual(1);
    expect(stats.categories.find((c) => c.category === "it")!.count).toBeGreaterThanOrEqual(1);
  });

  it("Auskunft: eigene Meldungen der Lehrkraft stehen im Export, Prüfungen und Anlagen nie (kein Personenbezug)", async () => {
    const data = (await collectPersonalData(h.db, JANA))!;
    const tables = data.sections.map((s) => s.table);
    expect(tables).toContain("gebaeude_tickets");
    expect(tables).not.toContain("gebaeude_inspections");
    expect(tables).not.toContain("gebaeude_assets");
    const klaus = (await collectPersonalData(h.db, KLAUS))!;
    expect(klaus.files.some((f) => f.path.includes("gebaeude_inspections"))).toBe(false);
  });

  it("Vorlage bleibt bei angepassten Prüfarten unverändert", async () => {
    const sabine = await p(SABINE);
    const types = await listInspectionTypes(h.db);
    const t = types.find((x) => x.templateKey === "trinkwasser")!;
    await updateInspectionType(h.db, sabine, t.id, { ...t, intervalMonths: 12, source: "Gesundheitsamt" }, today);
    await ensureTemplate(h.db);
    const [after] = await h.db.select().from(gebaeudeInspectionTypes).where(eq(gebaeudeInspectionTypes.templateKey, "trinkwasser"));
    expect(after).toMatchObject({ intervalMonths: 12, source: "Gesundheitsamt" });
  });

  it("Zähler und Filter auch bei mehr als 1000 offenen Prüfungen vollständig (Code-Review Gate 4a N9)", async () => {
    const sabine = await p(SABINE);
    const types = await listInspectionTypes(h.db, { activeOnly: true });
    const walk = types.find((t) => t.templateKey === "begehung-arbeitsschutz")!;
    const before = await inspectionSummary(h.db, sabine, today);
    await h.db.insert(gebaeudeInspections).values(Array.from({ length: 1005 }, (_, n) => ({ typeId: walk.id, building: `Massen-${n}`, dueOn: addDays(today, -5) })));
    const after = await inspectionSummary(h.db, sabine, today);
    expect(after.overdue - before.overdue).toBe(1005);
    expect(after.open - before.open).toBe(1005);
    expect(after.due).toBe(before.due);
    // „bald fällig“ wird nicht von den vielen überfälligen verdrängt
    expect((await listInspections(h.db, sabine, { state: "faellig" }, today)).length).toBe(before.due);
    expect((await listInspections(h.db, sabine, { state: "ueberfaellig" }, today)).every((r) => r.state === "ueberfaellig")).toBe(true);
    await h.db.delete(gebaeudeInspections).where(sql`${gebaeudeInspections.building} like 'Massen-%'`);
  });

  it("Job „gebaeude-fristen“ um 4 Uhr, läuft nur bei eingeschaltetem Modul", async () => {
    const job = SCHEDULED_JOBS.find((j) => j.name === "gebaeude-fristen")!;
    expect(job).toMatchObject({ at: "04:00", until: "06:00" });
    const later = new Date(Date.now() + 30 * 86_400_000);
    await setModuleEnabled(h.db, manifest, false);
    const before = (await gongs(KLAUS)).length;
    expect(await job.run(h.db, later)).toBeUndefined();
    expect((await gongs(KLAUS)).length).toBe(before);
    await setModuleEnabled(h.db, manifest, true);
    expect(await job.run(h.db, later)).toMatchObject({ mailed: false });
    expect((await gongs(KLAUS)).length).toBe(before + 1);
  });
});
