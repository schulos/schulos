// GS-01/GS-02 (Runde 13): Fachraum-Prüfungen in der Vorlage und zuständige Gruppe je Prüfart – Erinnerungen an die Gruppe,
// Erfassen/Planen/Streichen nur für die eigene Prüfart, Filter „meine Zuständigkeit“, Rechte-Matrix.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, gebaeudeAssetCategories, gebaeudeInspectionTypes, gebaeudeInspections, gebaeudeTickets, groupMembers, groups, notifications } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, type FileStorage } from "@/core/files/storage";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { addDays, toBerlinDate } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { ASSET_CATEGORY_TEMPLATE, matchCategory } from "./kategorien";
import { ticketCategoryForAsset } from "./labels";
import { FACHRAUM_TEMPLATE_KEYS, INSPECTION_TEMPLATE, TEMPLATE_DISCLAIMER } from "./pruefarten";
import {
  canSeeInspections,
  cancelInspection,
  checklist,
  ensureTemplate,
  inspectionAssetOptions,
  inspectionSummary,
  inspectionsCsv,
  listInspections,
  listInspectionTypes,
  planInspection,
  recordInspection,
  reportFor,
  responsibleInspectionTypes,
  runInspectionReminders,
  updateInspectionType,
} from "./pruefungen";

const ALBERS = "u-henrik.albers"; // Lehrkraft, Fachschaft Chemie (Leitung)
const POPESCU = "u-elena.popescu"; // Lehrkraft, Fachschaft Chemie
const JANA = "u-jana.brandt"; // Lehrkraft, nicht in der Fachschaft Chemie
const LEA = "u-lea.schaefer"; // Schülerin – wird testweise in die Fachschaft gesetzt (zählt nie als zuständig)
const KLAUS = "u-klaus.berger"; // Hausmeisterei: gebaeude.manage
const SABINE = "u-sabine.kowalski"; // Verwaltung: configure + view_all
const FS_CH = "g-fs-ch";
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

describe("GS-01: Fachraum-Vorlage (rein)", () => {
  it("sieben Fachraum-Prüfarten, alle „zu prüfen“, Kategorien der Anlagen in der Kategorien-Vorlage mit Prüfpflicht", () => {
    expect(FACHRAUM_TEMPLATE_KEYS).toHaveLength(7);
    for (const key of FACHRAUM_TEMPLATE_KEYS) {
      const t = INSPECTION_TEMPLATE.find((x) => x.key === key)!;
      expect(t, key).toBeDefined();
      expect(t.source.endsWith(TEMPLATE_DISCLAIMER)).toBe(true);
      expect(t.source.length).toBeLessThanOrEqual(300);
      expect(t.intervalMonths).toBeGreaterThan(0);
      if (t.categoryKey) expect(ASSET_CATEGORY_TEMPLATE.find((c) => c.key === t.categoryKey)?.inspectionRequired).toBe(true);
    }
    // Anlagenarten Abzug/Notdusche/Sicherheitsschrank als Kategorien (nicht als Enum), Notduschen monatlich
    expect(INSPECTION_TEMPLATE.filter((t) => FACHRAUM_TEMPLATE_KEYS.includes(t.key)).map((t) => t.categoryKey).filter(Boolean)).toEqual(["abzug", "notdusche", "sicherheitsschrank"]);
    expect(INSPECTION_TEMPLATE.find((t) => t.key === "notduschen")?.intervalMonths).toBe(1);
    // Gefahrstoffverzeichnis: nur Frist für die ganze Schule (kein Kataster), Strahlenschutz bei der Physiksammlung (Raum)
    expect(INSPECTION_TEMPLATE.find((t) => t.key === "gefahrstoffverzeichnis")).toMatchObject({ appliesTo: "gebaeude", categoryKey: null });
    expect(INSPECTION_TEMPLATE.find((t) => t.key === "strahlenschutz-dichtheit")).toMatchObject({ appliesTo: "raum", responsible: "extern" });
    // Kurzformen aus Inventarlisten und Meldungskategorie bei Mangel
    const cats = ASSET_CATEGORY_TEMPLATE.map((t) => ({ id: t.key, key: t.key, name: t.name, prefix: t.prefix }));
    expect(matchCategory("Laborabzug", cats)?.key).toBe("abzug");
    expect(matchCategory("Augendusche", cats)?.key).toBe("notdusche");
    expect(matchCategory("gefahrstoffschrank", cats)?.key).toBe("sicherheitsschrank");
    for (const k of ["abzug", "notdusche", "sicherheitsschrank"]) expect(ticketCategoryForAsset(k)).toBe("sicherheit");
  });
});

describe("GS-01/GS-02: Fachraum-Prüfungen mit zuständiger Gruppe – Service", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  const today = toBerlinDate(new Date());
  const p = (id: string) => loadPermissions(h.db, id);
  const typeByKey = async (key: string) => (await listInspectionTypes(h.db)).find((t) => t.templateKey === key)!;
  const gongs = async (userId: string) => (await h.db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.moduleId, "gebaeude")))).map((n) => n.title);

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-fachraum-"));
    storage = localStorage(dir);
  }, 60_000);
  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Vorlage bei bestehender Installation: Fachraum-Prüfarten und -Kategorien kommen ausgeschaltet dazu, angepasste bleiben", async () => {
    // wie eine Installation vor GS-01: Fachraum-Einträge fehlen, eine bestehende Prüfart ist angepasst
    await h.db.delete(gebaeudeInspectionTypes).where(inArray(gebaeudeInspectionTypes.templateKey, [...FACHRAUM_TEMPLATE_KEYS]));
    await h.db.delete(gebaeudeAssetCategories).where(inArray(gebaeudeAssetCategories.key, ["abzug", "notdusche", "sicherheitsschrank"]));
    await h.db.update(gebaeudeInspectionTypes).set({ intervalMonths: 18 }).where(eq(gebaeudeInspectionTypes.templateKey, "leitern"));
    await ensureTemplate(h.db);
    await ensureTemplate(h.db);
    const types = await listInspectionTypes(h.db);
    const fach = types.filter((t) => t.templateKey && FACHRAUM_TEMPLATE_KEYS.includes(t.templateKey));
    expect(fach).toHaveLength(7);
    expect(fach.every((t) => !t.active && t.responsibleGroupId === null)).toBe(true);
    expect(fach.find((t) => t.templateKey === "laborabzuege")?.categoryName).toBe("Laborabzug");
    expect(types.find((t) => t.templateKey === "leitern")?.intervalMonths).toBe(18);
    expect(types.filter((t) => t.templateKey)).toHaveLength(INSPECTION_TEMPLATE.length);
  });

  it("Zuständige Gruppe setzen: nur mit configure, nur Funktionsgruppen; Wechsel im Audit-Log", async () => {
    const [sabine, klaus] = await Promise.all([p(SABINE), p(KLAUS)]);
    const t = await typeByKey("gefahrstoffverzeichnis");
    await expect(updateInspectionType(h.db, klaus, t.id, { ...t, responsibleGroupId: FS_CH }, today)).rejects.toThrow(ForbiddenError);
    const [klasse] = await h.db.select({ id: groups.id }).from(groups).where(eq(groups.kind, "klasse")).limit(1);
    expect(await fieldErrors(updateInspectionType(h.db, sabine, t.id, { ...t, responsibleGroupId: klasse!.id }, today))).toMatchObject({ responsibleGroupId: expect.any(String) });
    expect(await fieldErrors(updateInspectionType(h.db, sabine, t.id, { ...t, responsibleGroupId: "gibt-es-nicht" }, today))).toMatchObject({ responsibleGroupId: "Gruppe gibt es nicht" });
    await updateInspectionType(h.db, sabine, t.id, { ...t, active: true, responsibleGroupId: FS_CH }, today);
    // ohne Feld bleibt die Gruppe (z. B. ältere Formulare)
    await updateInspectionType(h.db, sabine, t.id, { ...(await typeByKey("gefahrstoffverzeichnis")), responsibleGroupId: undefined, warnDays: 45 }, today);
    expect(await typeByKey("gefahrstoffverzeichnis")).toMatchObject({ active: true, warnDays: 45, responsibleGroupId: FS_CH, responsibleGroupName: "Fachschaft Chemie" });
    const logs = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "gebaeude.inspection_type.group"), eq(auditLog.target, t.id)));
    expect(logs).toHaveLength(1);
  });

  it("Rechte-Matrix: Fachschaft sieht, plant, erfasst und streicht nur ihre Prüfart; Schülerin in der Gruppe und andere Lehrkräfte nichts", async () => {
    const [albers, jana, klaus, sabine] = await Promise.all([p(ALBERS), p(JANA), p(KLAUS), p(SABINE)]);
    await h.db.insert(groupMembers).values({ groupId: FS_CH, userId: LEA, role: "member" });
    const lea = await p(LEA);
    const own = await typeByKey("gefahrstoffverzeichnis");
    const foreign = await typeByKey("brandschutz-technik");

    expect([...(await responsibleInspectionTypes(h.db, albers))]).toEqual([own.id]);
    expect((await responsibleInspectionTypes(h.db, lea)).size).toBe(0);
    expect(await canSeeInspections(h.db, albers)).toBe(true);
    expect(await canSeeInspections(h.db, jana)).toBe(false);
    for (const v of [jana, lea]) await expect(listInspections(h.db, v, {}, today)).rejects.toThrow(ForbiddenError);

    // Planen: eigene Prüfart ja, fremde nein (auch nicht bei bekannter ID)
    const id = await planInspection(h.db, albers, { typeId: own.id, building: "Hauptgebäude", dueOn: addDays(today, -3) });
    await expect(planInspection(h.db, albers, { typeId: foreign.id, building: "Hauptgebäude", dueOn: today })).rejects.toThrow(ForbiddenError);
    await expect(planInspection(h.db, jana, { typeId: own.id, building: "Pavillon", dueOn: today })).rejects.toThrow(ForbiddenError);

    // Lesen: nur die eigene Prüfart, auch in der Übersicht; Hausmeisterei sieht weiter alles
    const list = await listInspections(h.db, albers, { state: "alle" }, today);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.typeId === own.id)).toBe(true);
    expect(await inspectionSummary(h.db, albers, today)).toEqual({ overdue: 1, due: 0, open: 1 });
    expect((await listInspections(h.db, klaus, {}, today)).some((r) => r.id === id)).toBe(true);
    expect((await listInspections(h.db, klaus, {}, today)).some((r) => r.typeId !== own.id)).toBe(true);
    // Filter „meine Zuständigkeit“: Verwaltung ist in keiner zuständigen Gruppe → leer
    expect(await listInspections(h.db, sabine, { mine: true }, today)).toEqual([]);
    expect((await inspectionSummary(h.db, sabine, today, { mine: true })).open).toBe(0);
    // Nachweise für den Schulträger (CSV, Prüfliste) bleiben bei „alles lesen“
    await expect(inspectionsCsv(h.db, albers, today)).rejects.toThrow(ForbiddenError);
    await expect(checklist(h.db, albers, {}, today)).rejects.toThrow(ForbiddenError);
    // Anlagen beim Planen: Gefahrstoffverzeichnis hat keine Kategorie → keine Anlagen; Hausmeisterei alle
    expect(await inspectionAssetOptions(h.db, albers)).toEqual([]);
    expect((await inspectionAssetOptions(h.db, klaus)).length).toBeGreaterThan(0);

    // Erfassen: fremde Prüfung (Demo-Leiter) nein, eigene mit PDF ja – Folgeprüfung + Intervall, Protokoll lesbar
    const ladder = (await listInspections(h.db, klaus, { state: "ueberfaellig" }, today)).find((r) => r.typeId !== own.id)!;
    await expect(recordInspection(h.db, storage, albers, ladder.id, { doneOn: today, result: "ok", company: null, note: null }, { today })).rejects.toThrow(ForbiddenError);
    await expect(recordInspection(h.db, storage, jana, id, { doneOn: today, result: "ok", company: null, note: null }, { today })).rejects.toThrow(ForbiddenError);
    const r = await recordInspection(h.db, storage, albers, id, { doneOn: today, result: "ok", company: "Fachschaft", note: null, report: PDF }, { today });
    expect(r.ticketId).toBeNull();
    expect(r.nextId).not.toBeNull();
    expect(await reportFor(h.db, albers, id)).toMatchObject({ doneOn: today });
    expect(await reportFor(h.db, jana, id)).toBeNull();
    expect(await reportFor(h.db, albers, ladder.id)).toBeNull();
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "gebaeude.inspection.plan"), eq(auditLog.target, id)))).toHaveLength(1);

    // Mangel aus der Fachschaft → Meldung „Sicherheit“/Gebäude über das Melderecht der Lehrkraft
    const r2 = await recordInspection(h.db, storage, albers, r.nextId!, { doneOn: today, result: "mangel", company: null, note: "Verzeichnis unvollständig" }, { today });
    expect(r2.ticketId).not.toBeNull();
    const [ticket] = await h.db.select().from(gebaeudeTickets).where(eq(gebaeudeTickets.id, r2.ticketId!));
    expect(ticket!.reporterId).toBe(ALBERS);

    // Streichen: eigene offene Prüfung ja, fremde nein
    await expect(cancelInspection(h.db, albers, ladder.id)).rejects.toThrow(ForbiddenError);
    await cancelInspection(h.db, albers, r2.nextId!);
    expect(await h.db.select().from(gebaeudeInspections).where(eq(gebaeudeInspections.id, r2.nextId!))).toEqual([]);

    // gesperrtes Konto: keine Zuständigkeit
    expect((await responsibleInspectionTypes(h.db, { ...albers, locked: true })).size).toBe(0);
  });

  it("Erinnerungen: Fachschaft bekommt ihre Fristen (Hausmeisterei nicht), ohne Mitglieder fällt es an gebaeude.manage zurück", async () => {
    const sabine = await p(SABINE);
    const albers = await p(ALBERS);
    const own = await typeByKey("gefahrstoffverzeichnis");
    await planInspection(h.db, albers, { typeId: own.id, building: "Pavillon", dueOn: addDays(today, -1) });
    await h.db.delete(notifications);
    const res = await runInspectionReminders(h.db, { now: new Date() });
    expect(res.overdue).toBeGreaterThanOrEqual(2);
    const chem = (await gongs(ALBERS)).filter((g) => g.includes("Fachschaft Chemie"));
    expect(chem).toEqual(["Prüfungen (Fachschaft Chemie): 1 überfällig"]);
    expect(await gongs(POPESCU)).toEqual(chem);
    expect(await gongs(LEA)).toEqual([]);
    expect(await gongs(JANA)).toEqual([]);
    // Hausmeisterei: nur die eigenen (Demo-Leiter, Feuerlöscher), nicht die Fachschafts-Frist
    const klaus = await gongs(KLAUS);
    expect(klaus).toHaveLength(1);
    expect(klaus[0]).toMatch(/^Prüfungen: /);
    const [n] = await h.db.select().from(notifications).where(and(eq(notifications.userId, ALBERS), eq(notifications.moduleId, "gebaeude")));
    expect(n!.href).toBe("/gebaeude/pruefungen?stand=ueberfaellig&zustaendig=meine");

    // Gruppe ohne Beschäftigte: Erinnerung geht an gebaeude.manage (eine Frist geht nie unter)
    await h.db.insert(groups).values({ id: "g-leer", name: "Leere Gruppe", slug: "leere-gruppe", kind: "frei" });
    await updateInspectionType(h.db, sabine, own.id, { ...(await typeByKey("gefahrstoffverzeichnis")), responsibleGroupId: "g-leer" }, today);
    await h.db.update(gebaeudeInspections).set({ remindedAt: null }).where(eq(gebaeudeInspections.typeId, own.id));
    await h.db.delete(notifications);
    await runInspectionReminders(h.db, { now: new Date(Date.now() + 86_400_000) });
    expect(await gongs(ALBERS)).toEqual([]);
    expect((await gongs(KLAUS)).join(" ")).toMatch(/Prüfungen: \d+ überfällig/);
    expect((await listInspections(h.db, albers, {}, today).catch((e: unknown) => e)) instanceof ForbiddenError).toBe(true);
  });
});
