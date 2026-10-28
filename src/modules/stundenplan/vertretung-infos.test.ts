// VT-01: Vertretung „mehr Infos“ – Grund-Kategorie mit Vorgabe (F-10-8), interner Hinweis, „nur Betreuung“ (F-10-9), `updated_*`,
// Kenntnisnahme (F-10-10), Historie mit Vorher/Nachher aus allen Schreibpfaden (F-10-13), Material ohne Abwesenheit (F-10-12),
// Tagesmitteilungen mit Tagesfreigabe, Querschnitt „intern nie außen“ und Bereinigung bei Kontolöschung.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import {
  notifications,
  timetableAbsenceMaterials,
  timetableAbsences,
  timetableDayNotes,
  timetableLessons,
  timetableRoomBlocks,
  timetableSubstitutionChanges,
  timetableSubstitutionDays,
  timetableSubstitutions,
  users,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import type { FileStorage } from "@/core/files/storage";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { deleteAccounts } from "@/core/privacy/konto";
import { monitorData } from "@/modules/monitor/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { createAbsence } from "./abwesenheit";
import { savePermanentSubstitution } from "./dauervertretung";
import { deleteLesson } from "./manage";
import { createRoomBlock } from "./raumsperren";
import { materialsFor, saveMaterial } from "./selbstmeldung";
import { listSlots } from "./service";
import { SUBSTITUTION_ACK } from "./settings";
import { DELETED_TEACHER } from "./solverlauf-konto";
import { dayNotesOn, deleteDayNote, saveDayNote } from "./tagesmitteilungen";
import { acknowledgeSubstitution, defaultReason, deleteSubstitution, lessonSubstitution, ownSubstitutions, publishDay, saveSubstitution, substitutionsOn } from "./vertretung";
import { changedFields, snapshotOf, substitutionHistory } from "./vertretung-historie";

const MO = "2026-10-05";
const MO2 = "2026-10-12";
const BRA = "u-jana.brandt";
const KLE = "u-tobias.kleine";
const WAG = "u-sophie.wagner";
const RIC = "u-jonas.richter";
const PLANUNG = "u-frank.schulte";
const OTHER = "u-murat.yilmaz";
const LEA = "u-lea.schaefer"; // 7b
const SECRET = "INTERN-Schluessel-im-Sekretariat";

async function fieldErrors(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ValidationError) return err.fieldErrors;
    throw err;
  }
  throw new Error("keine ValidationError");
}

function memStorage(): FileStorage {
  const files = new Map<string, Uint8Array>();
  return {
    put: async (k: string, d: Uint8Array) => void files.set(k, d),
    get: async (k: string) => files.get(k) ?? null,
    delete: async (k: string) => void files.delete(k),
    list: async () => [],
  } as unknown as FileStorage;
}

describe("VT-01 rein", () => {
  it("Historien-Stand und geänderte Felder", () => {
    const row = { lessonId: "l", kind: "substitute" as const, substituteId: "t", roomId: null, subjectId: null, targetPeriod: null, mergeLessonId: null, note: "S. 24" };
    const a = snapshotOf(row);
    expect(a).toEqual({ ...row, internalNote: null, reason: null, supervisionOnly: false });
    expect(changedFields(a, { ...a, roomId: "105", supervisionOnly: true })).toEqual(["roomId", "supervisionOnly"]);
    expect(changedFields(null, a)).toEqual([]);
  });
});

describe("VT-01 Vertretung mehr Infos", () => {
  let h: DbHandle;
  const ids: Record<string, string> = {};
  const mo = { weekday: 0, validFrom: "2026-08-01", validUntil: null };
  const p = (u: string) => loadPermissions(h.db, u);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  beforeEach(async () => {
    await h.db.delete(timetableSubstitutions);
    await h.db.delete(timetableSubstitutionChanges);
    await h.db.delete(timetableSubstitutionDays);
    await h.db.delete(timetableAbsenceMaterials);
    await h.db.delete(timetableLessons);
    await h.db.delete(timetableAbsences);
    await h.db.delete(timetableRoomBlocks);
    await h.db.delete(timetableDayNotes);
    const rows = await h.db
      .insert(timetableLessons)
      .values([
        // 7b am Montag: 1. Sport (KLE), 3. Mathe (RIC), 4. Bio (BRA), 5. Deutsch (BRA)
        { ...mo, groupId: "g-7b", periodNr: 1, subjectId: "SP", teacherId: KLE, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 3, subjectId: "M", teacherId: RIC, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 4, subjectId: "BI", teacherId: BRA, roomId: "106" },
        { ...mo, groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: BRA, roomId: "106" },
        // 7a: 1. Mathe (WAG), 4. Englisch (KLE)
        { ...mo, groupId: "g-7a", periodNr: 1, subjectId: "M", teacherId: WAG, roomId: "105" },
        { ...mo, groupId: "g-7a", periodNr: 4, subjectId: "E", teacherId: KLE, roomId: "105" },
      ])
      .returning({ id: timetableLessons.id, groupId: timetableLessons.groupId, periodNr: timetableLessons.periodNr });
    for (const r of rows) ids[`${r.groupId.slice(2)}-${r.periodNr}`] = r.id;
  });

  const save = (lessonId: string, kind: "cancel" | "substitute" | "room" | "move" | "merge", extra: Partial<Parameters<typeof saveSubstitution>[2]> = {}, actor = "u-admin", date = MO) =>
    saveSubstitution(h.db, actor, { lessonId, date, kind, substituteId: null, roomId: null, note: null, ...extra });
  const row = async (lessonId: string, date = MO) =>
    (await h.db.select().from(timetableSubstitutions).where(and(eq(timetableSubstitutions.lessonId, lessonId), eq(timetableSubstitutions.date, date))))[0]!;
  const history = () => h.db.select().from(timetableSubstitutionChanges).orderBy(timetableSubstitutionChanges.createdAt);

  it("Grund-Kategorie: Vorgabe aus Abwesenheit (immer „Lehrkraft abwesend“), Gruppengrund 1:1, Raumsperre; gewählt bleibt gewählt", async () => {
    await createAbsence(h.db, "u-admin", { teacherId: BRA, groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: null });
    await createAbsence(h.db, "u-admin", { teacherId: null, groupId: "g-7a", startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "klassenfahrt", note: null });
    await createRoomBlock(h.db, "u-admin", { roomId: "106", startsOn: MO, endsOn: MO, fromPeriod: 3, toPeriod: 3, reason: "renovierung", note: null });

    await save(ids["7b-5"]!, "substitute", { substituteId: WAG });
    expect((await row(ids["7b-5"]!)).reason).toBe("lehrkraft_abwesend");
    await save(ids["7a-1"]!, "cancel");
    expect((await row(ids["7a-1"]!)).reason).toBe("klassenfahrt");
    await save(ids["7b-3"]!, "room", { roomId: "105" });
    expect((await row(ids["7b-3"]!)).reason).toBe("raum_gesperrt");
    expect(await defaultReason(h.db, { teacherId: KLE, groupId: "g-7b", roomId: "106", periodNr: 1 }, MO, "cancel")).toBeNull();

    // gewählt: bleibt beim „Vorschlag übernehmen“ (Feld fehlt); leer = wieder die Vorgabe
    await save(ids["7b-1"]!, "cancel", { reason: "veranstaltung" });
    expect((await row(ids["7b-1"]!)).reason).toBe("veranstaltung");
    await save(ids["7b-1"]!, "substitute", { substituteId: RIC });
    expect((await row(ids["7b-1"]!)).reason).toBe("veranstaltung");
    await save(ids["7b-1"]!, "substitute", { substituteId: RIC, reason: null });
    expect((await row(ids["7b-1"]!)).reason).toBeNull();
    expect(await fieldErrors(save(ids["7b-1"]!, "cancel", { reason: "krank" as never }))).toHaveProperty("reason");
    // Vertretungsplan nennt nur die Kategorie, nie den Abwesenheitsgrund
    const plan = await substitutionsOn(h.db, [MO], { drafts: true });
    expect(plan.find((e) => e.lessonId === ids["7b-5"])).toMatchObject({ reason: "lehrkraft_abwesend" });
    expect(JSON.stringify(plan)).not.toContain("krank");
  });

  it("interner Hinweis, „nur Betreuung“, Anlegen bleibt in created_*, Änderung in updated_*, Kenntnisnahme", async () => {
    expect(await fieldErrors(save(ids["7b-5"]!, "substitute", { substituteId: WAG, internalNote: "x".repeat(301) }))).toHaveProperty("internalNote");
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, internalNote: ` ${SECRET} `, supervisionOnly: true });
    const first = await row(ids["7b-5"]!);
    expect(first).toMatchObject({ internalNote: SECRET, supervisionOnly: true, createdBy: "u-admin", updatedBy: null, updatedAt: null, acknowledgedAt: null });

    // Kenntnisnahme: nur die Vertretungslehrkraft, nur an veröffentlichten Tagen
    await publishDay(h.db, "u-admin", MO);
    expect(await fieldErrors(acknowledgeSubstitution(h.db, KLE, first.id))).toHaveProperty("acknowledge");
    await acknowledgeSubstitution(h.db, WAG, first.id);
    expect((await row(ids["7b-5"]!)).acknowledgedAt).toBeInstanceOf(Date);

    // Vorschlag übernehmen (Felder fehlen): Hinweis, Betreuung und Kenntnisnahme bleiben; Anlegen bleibt, Änderung wird vermerkt
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, note: "Arbeitsheft S. 24" }, PLANUNG);
    const second = await row(ids["7b-5"]!);
    expect(second).toMatchObject({ id: first.id, internalNote: SECRET, supervisionOnly: true, createdBy: "u-admin", createdAt: first.createdAt, updatedBy: PLANUNG });
    expect(second.acknowledgedAt).toBeInstanceOf(Date);
    // andere Vertretungslehrkraft → Kenntnisnahme fällt weg
    await save(ids["7b-5"]!, "substitute", { substituteId: RIC }, PLANUNG);
    expect((await row(ids["7b-5"]!)).acknowledgedAt).toBeNull();
    // „nur Betreuung“ gibt es nur bei einer Vertretung; leerer Hinweis löscht
    await save(ids["7b-5"]!, "cancel", { supervisionOnly: true, internalNote: "" });
    expect(await row(ids["7b-5"]!)).toMatchObject({ kind: "cancel", supervisionOnly: false, internalNote: null });

    // ausgeschaltet → keine Kenntnisnahme
    await save(ids["7b-4"]!, "substitute", { substituteId: WAG });
    await writeModuleSetting(h.db, SUBSTITUTION_ACK, "aus");
    expect(await fieldErrors(acknowledgeSubstitution(h.db, WAG, (await row(ids["7b-4"]!)).id))).toHaveProperty("acknowledge");
    await writeModuleSetting(h.db, SUBSTITUTION_ACK, "an");
  });

  it("Historie: Anlegen, Ändern, gleiches Speichern ohne Eintrag, Aufheben, Tausch, Dauervertretung, Stunde löschen – nur für die Planung", async () => {
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, internalNote: SECRET });
    await save(ids["7b-5"]!, "substitute", { substituteId: RIC, internalNote: SECRET });
    await save(ids["7b-5"]!, "substitute", { substituteId: RIC, internalNote: SECRET });
    const s = await row(ids["7b-5"]!);
    await deleteSubstitution(h.db, PLANUNG, s.id);
    let all = await history();
    expect(all.map((c) => c.action)).toEqual(["create", "update", "delete"]);
    expect(all[0]).toMatchObject({ before: null, after: { substituteId: WAG, internalNote: SECRET, kind: "substitute" }, actorId: "u-admin", date: MO, lessonId: ids["7b-5"] });
    expect(all[1]).toMatchObject({ before: { substituteId: WAG }, after: { substituteId: RIC } });
    expect(all[2]).toMatchObject({ before: { substituteId: RIC }, after: null, actorId: PLANUNG, substitutionId: null });

    // Stufe 2: Verlegung mit Tausch schreibt beide Stunden
    await h.db.delete(timetableSubstitutionChanges);
    await save(ids["7b-1"]!, "move", { targetPeriod: 3, swap: true });
    all = await history();
    expect(all.map((c) => [c.action, c.lessonId, (c.after as { targetPeriod: number }).targetPeriod]).sort()).toEqual(
      [
        ["create", ids["7b-1"], 3],
        ["create", ids["7b-3"], 1],
      ].sort(),
    );

    // Dauervertretung: je Tag ein Eintrag
    await h.db.delete(timetableSubstitutionChanges);
    const absenceId = await createAbsence(h.db, "u-admin", { teacherId: BRA, groupId: null, startsOn: MO, endsOn: MO2, fromPeriod: null, toPeriod: null, reason: "fortbildung", note: null });
    await savePermanentSubstitution(h.db, "u-admin", { lessonId: ids["7b-4"]!, from: MO, absenceId, substituteId: WAG, supervisionOnly: true });
    all = await history();
    expect(all.map((c) => [c.action, c.date, (c.after as { supervisionOnly: boolean; reason: string }).supervisionOnly, (c.after as { reason: string }).reason])).toEqual([
      ["create", MO, true, "lehrkraft_abwesend"],
      ["create", MO2, true, "lehrkraft_abwesend"],
    ]);

    // Stunde löschen: die Vertretungen gehen per Kaskade mit – vorher in der Historie (SP3-05: Planung vor Schuljahresbeginn, die Stunde hat
    // noch keinen Vergangenheitsbezug und wird ganz gelöscht; im laufenden Plan endet sie am Vortag – sofortkorrektur.test.ts)
    await h.db.delete(timetableSubstitutionChanges);
    await deleteLesson(h.db, PLANUNG, ids["7b-4"]!, "2026-07-31");
    all = await history();
    expect(all.map((c) => [c.action, c.date, c.lessonId, (c.before as { lessonId: string }).lessonId])).toEqual([
      ["delete", MO, null, ids["7b-4"]],
      ["delete", MO2, null, ids["7b-4"]],
    ]);

    // nur für die Vertretungsplanung (F-10-13)
    await expect(substitutionHistory(h.db, await p(OTHER), MO, MO2)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(substitutionHistory(h.db, await p(LEA), MO, MO2)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await substitutionHistory(h.db, await p(PLANUNG), MO, MO2)).map((c) => c.action)).toEqual(["delete", "delete"]);
  });

  it("Querschnitt: interner Hinweis nie im Vertretungsplan, Schüler-/Lehrkraftplan, Monitor oder Gong (auch nicht bei Eltern)", async () => {
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, internalNote: SECRET, note: "Arbeitsheft" });
    await save(ids["7b-1"]!, "cancel", { internalNote: SECRET });
    await publishDay(h.db, "u-admin", MO);
    const outside = [
      await substitutionsOn(h.db, [MO]),
      await substitutionsOn(h.db, [MO], { drafts: true }),
      await listSlots(h.db, { kind: "group", id: "g-7b" }, MO, "2026-10-06"),
      await listSlots(h.db, { kind: "user", id: LEA }, MO, "2026-10-06"),
      await listSlots(h.db, { kind: "teacher", id: WAG }, MO, "2026-10-06"),
      await monitorData(h.db, { profile: "foyer" }, new Date("2026-10-05T06:00:00Z")),
      await monitorData(h.db, { profile: "lehrerzimmer" }, new Date("2026-10-05T06:00:00Z")),
      await h.db.select().from(notifications).where(eq(notifications.moduleId, "stundenplan")),
      // VT-02: Vertretungsplan mit Marker, „Meine Vertretungen“ einer anderen Lehrkraft, Klassenbuch-Hinweis für Schülerin/fremde Lehrkraft
      await substitutionsOn(h.db, [MO], { since: new Date(0) }),
      await ownSubstitutions(h.db, RIC, [MO]),
      await lessonSubstitution(h.db, await p(LEA), ids["7b-5"]!, MO),
      await lessonSubstitution(h.db, await p(RIC), ids["7b-5"]!, MO),
      await lessonSubstitution(h.db, await p(BRA), ids["7b-5"]!, MO),
    ];
    expect((outside[0] as unknown[]).length).toBeGreaterThan(0);
    expect((outside[7] as unknown[]).length).toBeGreaterThan(0);
    for (const o of outside) expect(JSON.stringify(o)).not.toContain(SECRET);
    // nur die Vertretungsplanung bekommt ihn ausdrücklich
    const internal = await substitutionsOn(h.db, [MO], { drafts: true, internal: true });
    expect(internal.find((e) => e.lessonId === ids["7b-5"])?.internal?.note).toBe(SECRET);
    // VT-02: … und die vertretende Lehrkraft dieser Stunde („Meine Vertretungen“, Klassenbuch-Hinweis)
    expect((await ownSubstitutions(h.db, WAG, [MO])).map((e) => e.internal?.note)).toEqual([SECRET]);
    expect((await lessonSubstitution(h.db, await p(WAG), ids["7b-5"]!, MO))?.internal?.note).toBe(SECRET);
    expect((await lessonSubstitution(h.db, await p(PLANUNG), ids["7b-5"]!, MO))?.internal?.note).toBe(SECRET);
  });

  it("Querschnitt (GATE VT): Grund und Notiz der Abwesenheit stehen nie in Vertretungsplan, Plänen, Monitor, Gong oder Klassenbuch-Hinweis", async () => {
    const ABS_NOTE = "ABWESEND-Notiz-Arzttermin";
    await createAbsence(h.db, "u-admin", { teacherId: BRA, groupId: null, startsOn: MO, endsOn: MO, fromPeriod: null, toPeriod: null, reason: "krank", note: ABS_NOTE });
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, note: "Arbeitsheft" });
    await save(ids["7b-4"]!, "cancel");
    await publishDay(h.db, "u-admin", MO);
    const outside = [
      await substitutionsOn(h.db, [MO], { since: new Date(0) }),
      await listSlots(h.db, { kind: "group", id: "g-7b" }, MO, "2026-10-06"),
      await listSlots(h.db, { kind: "user", id: LEA }, MO, "2026-10-06"),
      await listSlots(h.db, { kind: "teacher", id: WAG }, MO, "2026-10-06"),
      await monitorData(h.db, { profile: "foyer" }, new Date("2026-10-05T06:00:00Z")),
      await monitorData(h.db, { profile: "lehrerzimmer" }, new Date("2026-10-05T06:00:00Z")),
      await h.db.select().from(notifications).where(eq(notifications.moduleId, "stundenplan")),
      await ownSubstitutions(h.db, WAG, [MO]),
      await lessonSubstitution(h.db, await p(LEA), ids["7b-5"]!, MO),
      await lessonSubstitution(h.db, await p(WAG), ids["7b-5"]!, MO),
    ];
    expect((outside[0] as unknown[]).length).toBeGreaterThan(0);
    for (const o of outside) {
      const text = JSON.stringify(o);
      expect(text).not.toContain(ABS_NOTE);
      expect(text).not.toMatch(/krank/i);
    }
  });

  it("Material ohne Abwesenheit: Lehrkraft der Stunde, Vertretung und Planung dürfen; andere nicht; Schüler:innen nur mit Häkchen", async () => {
    const storage = memStorage();
    const input = { absenceId: null, lessonId: ids["7b-5"]!, date: MO, text: "Buch S. 34", forStudents: false };
    // Lehrkraft der Stunde
    const id = await saveMaterial(h.db, storage, await p(BRA), input);
    expect(id).toBeTruthy();
    // andere Lehrkraft ohne Bezug: nein
    await expect(saveMaterial(h.db, storage, await p(OTHER), { ...input, text: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    // Vertretungslehrkraft dieser Stunde: ja (überschreibt dasselbe Material)
    await save(ids["7b-5"]!, "substitute", { substituteId: OTHER });
    expect(await saveMaterial(h.db, storage, await p(OTHER), { ...input, text: "Buch S. 35", forStudents: true })).toBe(id);
    // Planung
    expect(await saveMaterial(h.db, storage, await p(PLANUNG), { ...input, text: "Buch S. 36", forStudents: true })).toBe(id);
    expect(await h.db.$count(timetableAbsenceMaterials, eq(timetableAbsenceMaterials.lessonId, ids["7b-5"]!))).toBe(1);
    // Stunde findet an dem Tag nicht statt
    expect(await fieldErrors(saveMaterial(h.db, storage, await p(BRA), { ...input, date: "2026-10-06" }))).toHaveProperty("material");
    // sehen: Lehrkraft der Stunde, Schüler:in der Gruppe (Häkchen), nicht eine fremde Lehrkraft ohne Bezug
    const key = `${ids["7b-5"]}:${MO}`;
    expect((await materialsFor(h.db, await p(BRA), [{ lessonId: ids["7b-5"]!, date: MO }])).get(key)?.text).toBe("Buch S. 36");
    expect((await materialsFor(h.db, await p(LEA), [{ lessonId: ids["7b-5"]!, date: MO }])).has(key)).toBe(true);
    expect((await materialsFor(h.db, await p(RIC), [{ lessonId: ids["7b-5"]!, date: MO }])).has(key)).toBe(false);
  });

  it("Tagesmitteilungen folgen der Tagesfreigabe und der Zielgruppe", async () => {
    await save(ids["7b-1"]!, "cancel"); // Demo-Schule im Modus „Freigabe“ → Entwurf
    const isDraft = (await h.db.$count(timetableSubstitutionDays, eq(timetableSubstitutionDays.date, MO))) > 0;
    const a = await saveDayNote(h.db, PLANUNG, null, { date: MO, body: "6. Stunde Schulversammlung in der Aula", audience: "alle" });
    await saveDayNote(h.db, PLANUNG, null, { date: MO, body: "Konferenz 14 Uhr", audience: "beschaeftigte" });
    expect(await fieldErrors(saveDayNote(h.db, PLANUNG, null, { date: MO, body: "x".repeat(301), audience: "alle" }))).toHaveProperty("body");
    expect(await fieldErrors(saveDayNote(h.db, PLANUNG, null, { date: MO, body: "x", audience: "eltern" }))).toHaveProperty("audience");
    expect((await dayNotesOn(h.db, [MO], { drafts: true, staff: true })).map((n) => n.body)).toEqual(["6. Stunde Schulversammlung in der Aula", "Konferenz 14 Uhr"]);
    expect(await dayNotesOn(h.db, [MO], { staff: true })).toHaveLength(isDraft ? 0 : 2);
    await publishDay(h.db, "u-admin", MO);
    expect((await dayNotesOn(h.db, [MO])).map((n) => n.body)).toEqual(["6. Stunde Schulversammlung in der Aula"]);
    expect(await dayNotesOn(h.db, [MO], { staff: true })).toHaveLength(2);
    await deleteDayNote(h.db, PLANUNG, a);
    expect(await dayNotesOn(h.db, [MO], { staff: true })).toHaveLength(1);
  });

  it("Kontolöschung ersetzt die Vertretungslehrkraft in der Historie (Kennung und Kürzel im Hinweis), „geändert von“ wird leer", async () => {
    const T = "u-vt01.weg";
    await h.db.insert(users).values({ id: T, name: "Lehrkraft Weg", email: "vt01@schule.test", role: "lehrkraft", status: "locked", leftOn: "2025-01-10", shortCode: "VWX" });
    await save(ids["7b-5"]!, "substitute", { substituteId: T, internalNote: "VWX bringt den Schlüssel", note: "bei VWX" });
    await save(ids["7b-5"]!, "substitute", { substituteId: WAG, note: "doch WAG" }, T);
    expect(await deleteAccounts(h.db, [T])).toBe(1);
    const rows = await h.db
      .select()
      .from(timetableSubstitutionChanges)
      .where(inArray(timetableSubstitutionChanges.lessonId, [ids["7b-5"]!]));
    const text = JSON.stringify(rows.map((r) => [r.before, r.after, r.actorId]));
    expect(rows).toHaveLength(2);
    expect(text).not.toContain(T);
    expect(text).not.toContain("VWX");
    // ohne ORDER BY ist die Reihenfolge unter PostgreSQL beliebig – die erste Speicherung hat kein „vorher“
    expect(rows.find((r) => r.before === null)?.after).toMatchObject({ substituteId: DELETED_TEACHER, internalNote: `${DELETED_TEACHER} bringt den Schlüssel` });
    expect(rows.every((r) => r.actorId !== T)).toBe(true);
  });
});

describe("VT-01 Leser interner Angaben (Grep)", () => {
  // Interner Hinweis und Historie: nur Planung (Vertretungsformular/-seite), Schreibpfade und Kontolöschung – kein Leser in
  // Schüler-/Eltern-Sichten, Monitor, Druck oder Exporten (R14, Querschnittstest a/d)
  const ALLOWED = new Set(
    [
      "src/modules/stundenplan/schema.ts",
      "src/modules/stundenplan/vertretung.ts",
      "src/modules/stundenplan/vertretung-historie.ts",
      "src/modules/stundenplan/vertretung-konto.ts",
      "src/modules/stundenplan/solverlauf.ts",
      // SP3-04: Rücknahme-Daten des Veröffentlichens (Vertretungen vollständig, wie beim Solver) und die frühere direkte Übernahme (nur Tests)
      "src/modules/stundenplan/veroeffentlichen.ts",
      "src/modules/stundenplan/solverlauf.testing.ts",
      "src/modules/stundenplan/actions.ts",
      "src/modules/stundenplan/dauervertretung.ts",
      "src/app/(shell)/planung/vertretungen/page.tsx",
      "src/app/(shell)/planung/vertretungen/substitution-form.tsx",
      // VT-02: „Meine Vertretungen“ und Klassenbuch-Hinweis – interner Hinweis nur für die vertretende Lehrkraft (über
      // `ownSubstitutions`/`lessonSubstitution`, Querschnittstest oben)
      "src/app/(shell)/stundenplan/vertretungen/page.tsx",
      "src/app/(shell)/klassenbuch/eintrag/page.tsx",
    ].map((f) => f.split("/").join(sep)),
  );
  const root = join(__dirname, "..", "..", "..");
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }
  it("nur erlaubte Dateien lesen `internalNote`, `internal_note`, `internal.note` oder `timetableSubstitutionChanges`", () => {
    const hits = walk(join(root, "src"))
      .filter((f) => /internalNote|internal_note|internal\??\.note|timetableSubstitutionChanges/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f))
      .filter((f) => !ALLOWED.has(f));
    expect(hits).toEqual([]);
  });
});
