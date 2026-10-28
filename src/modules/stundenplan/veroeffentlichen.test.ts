// SP3-04: Veröffentlichen einer Planversion ab Stichtag und Zurücknehmen (Demo-Schule) – unveränderte Stunden behalten ihre id,
// Klassenbuch vor/nach dem Stichtag bleibt zugeordnet, Vertretungen/Material ziehen um oder werden gezählt (Kopplung, A/B-Woche,
// Verlegung, Zusammenlegung, Material ohne Abwesenheit), Zurücknehmen stellt alles wieder her, nur eine Version gilt je Tag, von Varianten
// genau eine; Änderungsliste als Gong (Lehrkräfte sofort, Schüler:innen zur Vortags-Uhrzeit) ohne Entwurfsstunden und Kommentare.
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import {
  auditLog,
  classbookEntries,
  notifications,
  timetableAbsenceMaterials,
  timetableDraftLessons,
  timetableLessons,
  timetablePlanVersions,
  timetableSubstitutions,
  type TimetableLesson,
} from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import { pendingPublications, publishedTimeline, versionOn } from "./plan-archiv";
import { addComment, approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { cleanupVersions, createDraft, createVariant, getVersion, validVersion } from "./planversionen";
import { listSlots, regularSlots } from "./service";
import { planBundleKey, publishPreview, publishVersion, runPlanNotifications, undoPublish, undoPublishPreview, type PublishUndo } from "./veroeffentlichen";

const today = "2026-10-05";
const cutoff = "2027-02-01"; // Montag (KW 5, A-Woche), Beginn 2. Halbjahr
const yearId = "sj-2026-27";
const viewer: Viewer = { userId: "u-frank.schulte", manage: true, review: true };
// echte Uhrzeit nach dem Seed: „seit dem Veröffentlichen angelegt“ vergleicht mit der Anlagezeit der Stunden
let now = new Date();

describe("Veröffentlichen ab Stichtag (SP3-04, Demo-Schule)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
    now = new Date();
  }, 120_000);
  afterAll(() => h.close());

  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
      throw err;
    }
    throw new Error("keine ValidationError");
  };
  const liveRows = async () => (await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id))).map((r) => ({ ...r, createdAt: undefined }));
  const lessonOf = async (group: string, weekday: number, period: number): Promise<TimetableLesson> =>
    (await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.groupId, group), eq(timetableLessons.weekday, weekday), eq(timetableLessons.periodNr, period))))[0]!;
  const draftOf = async (versionId: string, originId: string) =>
    (await h.db.select().from(timetableDraftLessons).where(and(eq(timetableDraftLessons.versionId, versionId), eq(timetableDraftLessons.originLessonId, originId))))[0]!;
  const approve = async (id: string) => {
    await submitForReview(h.db, viewer, id, now);
    await approveVersion(h.db, viewer, id, now);
  };
  const subsSnapshot = async () =>
    (await h.db.select().from(timetableSubstitutions).orderBy(asc(timetableSubstitutions.id))).map((s) => ({ id: s.id, lessonId: s.lessonId, date: s.date, kind: s.kind, mergeLessonId: s.mergeLessonId, targetPeriod: s.targetPeriod, substituteId: s.substituteId }));

  it("Vorschau, Veröffentlichen, Übertrag, Archiv, Gong und Zurücknehmen", async () => {
    // Ausgangslage (7b): Mo 5. Deutsch → anderer Raum; Mi 1. entfällt; Di 3. → Do 7.; Mo 1. nur noch A-Woche; neu Fr 7.; Q1-Band Mo 4. (BI) anderer Raum
    const room = await lessonOf("g-7b", 0, 5);
    const gone = await lessonOf("g-7b", 2, 1);
    const moved = await lessonOf("g-7b", 1, 3);
    const ab = await lessonOf("g-7b", 0, 1);
    const keep = await lessonOf("g-7b", 0, 6);
    const band = await lessonOf("g-q1-bi-gk1", 0, 4);
    const bandParts = await h.db.select().from(timetableLessons).where(eq(timetableLessons.couplingId, band.couplingId!));
    const bandDe = bandParts.find((p) => p.id !== band.id)!;
    const host = (await h.db.select().from(timetableLessons).where(and(eq(timetableLessons.weekday, 0), eq(timetableLessons.periodNr, 5)))).find((l) => l.groupId !== "g-7b")!;

    const v = await createDraft(h.db, viewer.userId, { schoolYearId: yearId, source: "live_copy", validFrom: cutoff, numbering: "major", name: "2. Halbjahr" }, today);
    const d = timetableDraftLessons;
    await h.db.update(d).set({ roomId: "105" }).where(eq(d.id, (await draftOf(v.id, room.id)).id));
    await h.db.delete(d).where(eq(d.id, (await draftOf(v.id, gone.id)).id));
    await h.db.update(d).set({ weekday: 3, periodNr: 7 }).where(eq(d.id, (await draftOf(v.id, moved.id)).id));
    await h.db.update(d).set({ week: "A" }).where(eq(d.id, (await draftOf(v.id, ab.id)).id));
    await h.db.update(d).set({ roomId: "NW2" }).where(eq(d.id, (await draftOf(v.id, band.id)).id));
    const fresh = await draftOf(v.id, keep.id);
    await h.db.insert(d).values({ ...fresh, id: "d-neu-fr7", weekday: 4, periodNr: 7, subjectId: "MU", originLessonId: null, createdAt: undefined });
    // Kommentar der Prüfung – darf nie im Gong stehen
    await addComment(h.db, viewer, v.id, { targetKind: "version", body: "GEHEIM-KOMMENTAR zur Prüfung" }, now);
    await approve(v.id);
    const variant = await createVariant(h.db, viewer.userId, v.id);
    const other = await createDraft(h.db, viewer.userId, { schoolYearId: yearId, source: "live_copy", validFrom: "2027-03-01", numbering: "major", name: "Andere Planung" }, today);

    // Vertretungen, Material ohne Abwesenheit, Klassenbuch vor und nach dem Stichtag
    const s = timetableSubstitutions;
    await h.db.insert(s).values([
      { id: "s-raum", lessonId: room.id, date: "2027-02-01", kind: "cancel" },
      { id: "s-vorher", lessonId: room.id, date: "2027-01-25", kind: "cancel" },
      { id: "s-verl", lessonId: room.id, date: "2027-02-15", kind: "move", targetPeriod: 2 },
      { id: "s-weg", lessonId: gone.id, date: "2027-02-03", kind: "substitute", substituteId: "u-tobias.kleine" },
      { id: "s-tag", lessonId: moved.id, date: "2027-02-02", kind: "cancel" },
      { id: "s-a", lessonId: ab.id, date: "2027-02-01", kind: "room", roomId: "NW2" },
      { id: "s-b", lessonId: ab.id, date: "2027-02-08", kind: "room", roomId: "NW2" },
      { id: "s-bleibt", lessonId: keep.id, date: "2027-02-01", kind: "cancel" },
      { id: "s-zus", lessonId: host.id, date: "2027-02-08", kind: "merge", mergeLessonId: room.id },
      { id: "s-band", lessonId: bandDe.id, date: "2027-02-01", kind: "cancel" },
    ]);
    await h.db.insert(timetableAbsenceMaterials).values([
      { id: "m-raum", lessonId: room.id, date: "2027-02-01", text: "Buch S. 34" },
      { id: "m-weg", lessonId: gone.id, date: "2027-02-03", text: "Arbeitsblatt" },
    ]);
    const entry = { groupId: "g-7b", periodNr: 5, subjectId: "D", teacherId: "u-jana.brandt", topic: "Gedichte" };
    await h.db.insert(classbookEntries).values([
      { ...entry, id: "k-vorher", lessonId: room.id, date: "2027-01-25" },
      { ...entry, id: "k-nachher", lessonId: room.id, date: "2027-02-01" },
      { ...entry, id: "k-weg", lessonId: gone.id, date: "2027-02-03", periodNr: 1 },
    ]);

    // eine Stunde, die erst nach dem Anlegen des Entwurfs in den gültigen Plan kam und erst ab März gilt: entfällt ganz (gelöscht, kommt zurück)
    await h.db.insert(timetableLessons).values({ ...keep, id: "l-spaet", weekday: 1, periodNr: 7, validFrom: "2027-03-01", createdAt: undefined });
    const liveBefore = await liveRows();
    const subsBefore = await subsSnapshot();
    // Schülersicht vor dem Veröffentlichen: keine Entwurfsstunde (Fr 7.), Raum wie bisher
    const leaWeek = () => listSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, "2027-02-01", "2027-02-06");
    const beforeSlots = await leaWeek();
    expect(beforeSlots.some((x) => x.weekday === 4 && x.periodNr === 7)).toBe(false);
    expect(beforeSlots.find((x) => x.lessonId === room.id)?.roomId).toBe("106");
    expect(await pendingPublications(h.db, today)).toEqual([{ id: v.id, label: "2.0", name: "2. Halbjahr", validFrom: cutoff }]);

    // Vorschau mit Zahlen
    const pre = await publishPreview(h.db, v.id, cutoff, today);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.preview).toMatchObject({
      counts: { changed: 3 + bandParts.length, added: 1, removed: 2 },
      changedWithCoupling: bandParts.length - 1,
      ended: 4 + bandParts.length,
      deleted: 1,
      created: 4 + bandParts.length,
      substitutions: { moved: 5, removed: 3 },
      materials: { moved: 1, removed: 1 },
      classbook: { moved: 1, detached: 1 },
      previous: { label: "1.0", name: "Bestand" },
      variants: [{ label: "2.0", name: variant.name }],
      otherDrafts: 1,
    });
    expect(pre.preview.teachers).toBeGreaterThan(0);
    expect(pre.preview.groups).toBeGreaterThan(0);
    // nicht veröffentlichbar: Stichtag vor dem vorgemerkten, kein Schultag, nicht freigegeben
    expect(await publishPreview(h.db, v.id, "2027-01-25", today)).toMatchObject({ ok: false, problem: expect.stringContaining("frühestens ab diesem Tag") });
    expect(await publishPreview(h.db, v.id, "2027-02-06", today)).toMatchObject({ ok: false, problem: expect.stringContaining("kein Schultag") });
    expect(await publishPreview(h.db, other.id, "2027-03-01", today)).toMatchObject({ ok: false, problem: expect.stringContaining("Nur freigegebene") });
    expect(await liveRows()).toEqual(liveBefore);

    // Veröffentlichen
    const res = await publishVersion(h.db, viewer.userId, v.id, cutoff, today, now);
    expect(res).toMatchObject({ versionLabel: "2.0", created: 4 + bandParts.length, substitutions: { moved: 5, removed: 3 }, previous: "1.0", discardedVariants: 1 });
    const after = await h.db.select().from(timetableLessons);
    const byId = new Map(after.map((l) => [l.id, l]));
    // unveränderte Stunden: dieselbe Zeile, unverändert
    const touched = new Set([room.id, gone.id, moved.id, ab.id, ...bandParts.map((p) => p.id)]);
    for (const l of liveBefore.filter((x) => !touched.has(x.id) && x.id !== "l-spaet")) expect({ ...byId.get(l.id), createdAt: undefined }).toEqual({ ...l, createdAt: undefined });
    // geänderte/entfallende enden am Vortag; neue ab dem Stichtag mit Herkunft
    for (const id of touched) expect(byId.get(id)!.validUntil).toBe("2027-01-31");
    expect(byId.has("l-spaet")).toBe(false);
    const newRows = after.filter((l) => l.planVersionId === v.id);
    expect(newRows).toHaveLength(res.created);
    expect(newRows.every((l) => l.validFrom === cutoff)).toBe(true);
    const newRoom = newRows.find((l) => l.groupId === "g-7b" && l.weekday === 0 && l.periodNr === 5)!;
    expect(newRoom.roomId).toBe("105");
    const newBand = newRows.filter((l) => l.weekday === 0 && l.periodNr === 4 && bandParts.some((p) => p.groupId === l.groupId));
    expect(newBand).toHaveLength(bandParts.length);
    expect(new Set(newBand.map((l) => l.couplingId)).size).toBe(1);
    expect(newBand[0]!.couplingId).not.toBe(band.couplingId);

    // Übertrag
    const subs = new Map((await h.db.select().from(s)).map((x) => [x.id, x]));
    expect(subs.get("s-raum")!.lessonId).toBe(newRoom.id);
    expect(subs.get("s-verl")!.lessonId).toBe(newRoom.id);
    expect(subs.get("s-vorher")!.lessonId).toBe(room.id);
    expect(subs.get("s-bleibt")!.lessonId).toBe(keep.id);
    expect(subs.get("s-zus")!.mergeLessonId).toBe(newRoom.id);
    expect(subs.get("s-a")!.lessonId).toBe(newRows.find((l) => l.groupId === "g-7b" && l.weekday === 0 && l.periodNr === 1)!.id);
    expect(subs.get("s-band")!.lessonId).toBe(newBand.find((l) => l.groupId === bandDe.groupId)!.id);
    for (const id of ["s-weg", "s-tag", "s-b"]) expect(subs.has(id)).toBe(false);
    const mats = new Map((await h.db.select().from(timetableAbsenceMaterials)).map((x) => [x.id, x]));
    expect(mats.get("m-raum")!.lessonId).toBe(newRoom.id);
    expect(mats.has("m-weg")).toBe(false);
    const book = new Map((await h.db.select().from(classbookEntries).where(inArray(classbookEntries.id, ["k-vorher", "k-nachher", "k-weg"]))).map((x) => [x.id, x]));
    expect(book.get("k-vorher")!.lessonId).toBe(room.id);
    expect(book.get("k-nachher")!.lessonId).toBe(newRoom.id);
    expect(book.get("k-weg")!.lessonId).toBeNull();

    // Versionen: gültig ab Stichtag, Bestand archiviert bis Vortag, Variante verworfen, andere Planung bleibt
    const published = (await getVersion(h.db, v.id))!;
    expect(published).toMatchObject({ status: "gueltig", validFrom: cutoff, validUntil: null, publishedBy: viewer.userId });
    expect((published.undo as PublishUndo).substitutions.map((x) => x.id).sort()).toEqual(["s-b", "s-tag", "s-weg"]);
    expect((await validVersion(h.db, yearId))!.id).toBe(v.id);
    const versions = new Map((await h.db.select().from(timetablePlanVersions)).map((x) => [x.id, x]));
    expect(versions.get(published.parentVersionId!)).toMatchObject({ status: "archiviert", validUntil: "2027-01-31" });
    expect(versions.get(variant.id)!.status).toBe("verworfen");
    expect(versions.get(other.id)!.status).toBe("entwurf");
    expect(await pendingPublications(h.db, today)).toEqual([]);
    // Plan am Tag X: Version und Stunden vor/nach dem Stichtag
    expect((await versionOn(h.db, "2027-01-29"))!.label).toBe("1.0");
    expect((await versionOn(h.db, cutoff))!).toMatchObject({ label: "2.0", status: "gueltig" });
    expect((await publishedTimeline(h.db, yearId)).map((x) => [x.label, x.validFrom, x.validUntil])).toEqual([
      ["1.0", "2026-08-01", "2027-01-31"],
      ["2.0", cutoff, null],
    ]);
    const plan7b = async (ymd: string) => (await regularSlots(h.db, { kind: "group", id: "g-7b" }, ymd)).find((x) => x.weekday === 0 && x.periodNr === 5)!;
    expect((await plan7b("2027-01-29")).roomId).toBe("106");
    expect((await plan7b(cutoff)).roomId).toBe("105");
    // Schülersicht ab Stichtag: neue Stunde und Raum; Woche davor unverändert
    const leaAfter = await leaWeek();
    expect(leaAfter.some((x) => x.weekday === 4 && x.periodNr === 7)).toBe(true);
    expect((await listSlots(h.db, { kind: "user", id: "u-lea.schaefer" }, "2027-01-25", "2027-01-30")).find((x) => x.weekday === 0 && x.periodNr === 5)?.roomId).toBe("106");

    // nur eine Version je Tag: eine weitere Version ab demselben Stichtag geht nicht
    const second = await createDraft(h.db, viewer.userId, { schoolYearId: yearId, source: "live_copy", validFrom: cutoff, numbering: "minor", name: "Folge" }, today);
    await approve(second.id);
    expect(await errorOf(publishVersion(h.db, viewer.userId, second.id, cutoff, today, now))).toMatch(/je Tag gilt genau eine Version/);
    expect(await errorOf(publishVersion(h.db, viewer.userId, v.id, "2027-02-08", today, now))).toMatch(/schon veröffentlicht/);

    // Gong: Lehrkräfte sofort, Schüler:innen erst zur Vortags-Uhrzeit; nie Kommentare
    const key = planBundleKey(v.id);
    const gong = async (user: string) => (await h.db.select().from(notifications).where(and(eq(notifications.bundleKey, key), eq(notifications.userId, user))))[0];
    expect((await gong("u-jana.brandt"))!.title).toMatch(/^Neuer Stundenplan ab Mo\., 01\.02\.: \d+ Änderungen? für dich$/);
    expect((await gong("u-jana.brandt"))!.body).toContain("Raum 106 → 105");
    expect(await gong("u-frank.schulte")).toBeUndefined(); // wer veröffentlicht, weiß es
    expect(await gong("u-lea.schaefer")).toBeUndefined();
    expect(published.notifyAt!.toISOString()).toBe(new Date("2027-01-31T17:00:00Z").toISOString()); // Vortag 18:00 Berliner Zeit
    expect(await runPlanNotifications(h.db, now)).toBe(0);
    expect(await runPlanNotifications(h.db, published.notifyAt!)).toBeGreaterThan(0);
    expect(await runPlanNotifications(h.db, published.notifyAt!)).toBe(0); // genau einmal
    const leaGong = (await gong("u-lea.schaefer"))!;
    expect(leaGong.title).toMatch(/^Neuer Stundenplan ab/);
    expect(leaGong.body).toContain("neu: Fr 7. Std");
    const all = await h.db.select().from(notifications).where(eq(notifications.bundleKey, key));
    expect(all.some((n) => `${n.title} ${n.body}`.includes("GEHEIM"))).toBe(false);
    expect((await getVersion(h.db, v.id))!.notify).toBeNull();
    expect(await h.db.$count(auditLog, eq(auditLog.action, "stundenplan.plan.publish"))).toBe(1);

    // Zurücknehmen: Vorschau mit Konfliktzählung, dann alter Stand
    const undoPre = (await undoPublishPreview(h.db, v.id, today))!;
    expect(undoPre).toMatchObject({ lessons: res.created, changed: 0, substitutionsBack: 5, materialsBack: 1, classbookBack: 1, restorable: 4 + bandParts.length, reinsert: 1, restoredSubstitutions: 3, restoredMaterials: 1, reattachedClassbook: 1, foreign: 0 });
    expect(await undoPublishPreview(h.db, v.id, cutoff)).toBeNull();
    const back = await undoPublish(h.db, viewer.userId, v.id, today);
    expect(back).toMatchObject({ lessons: res.created, restorable: 4 + bandParts.length, restoredSubstitutions: 3, lostSubstitutions: 0, restoredMaterials: 1, reattachedClassbook: 1 });
    expect(await liveRows()).toEqual(liveBefore);
    expect(await subsSnapshot()).toEqual(subsBefore);
    expect((await h.db.select().from(timetableAbsenceMaterials).where(inArray(timetableAbsenceMaterials.id, ["m-raum", "m-weg"])).orderBy(asc(timetableAbsenceMaterials.id))).map((m) => [m.id, m.lessonId])).toEqual([
      ["m-raum", room.id],
      ["m-weg", gone.id],
    ]);
    expect((await h.db.select().from(classbookEntries).where(inArray(classbookEntries.id, ["k-nachher", "k-weg"])).orderBy(asc(classbookEntries.id))).map((k) => [k.id, k.lessonId])).toEqual([
      ["k-nachher", room.id],
      ["k-weg", gone.id],
    ]);
    const versionsBack = new Map((await h.db.select().from(timetablePlanVersions)).map((x) => [x.id, x]));
    expect(versionsBack.get(v.id)).toMatchObject({ status: "freigegeben", validFrom: cutoff, publishedAt: null, undo: null, notify: null });
    expect(versionsBack.get(published.parentVersionId!)).toMatchObject({ status: "gueltig", validUntil: null });
    expect(versionsBack.get(variant.id)!.status).toBe("entwurf");
    // wer die Änderungsliste bekommen hat, bekommt die Rücknahme
    expect((await gong("u-jana.brandt"))!.title).toMatch(/zurückgenommen$/);
    expect((await gong("u-lea.schaefer"))!.title).toMatch(/zurückgenommen$/);
    expect(await errorOf(undoPublish(h.db, viewer.userId, v.id, today))).toMatch(/nicht die gültige Version/);
  }, 120_000);

  it("Stichtag erreicht: keine Rücknahme mehr, der Nachtjob leert die Rücknahme-Daten; Kontolöschung ersetzt Lehrkraft-Kennungen darin", async () => {
    const [v] = await h.db.select().from(timetablePlanVersions).where(and(eq(timetablePlanVersions.status, "freigegeben"), eq(timetablePlanVersions.name, "2. Halbjahr")));
    const res = await publishVersion(h.db, viewer.userId, v!.id, cutoff, today, now);
    expect(res.substitutions.removed).toBe(3);
    const undo = () => getVersion(h.db, v!.id).then((x) => JSON.stringify(x!.undo));
    expect(await undo()).toContain("u-tobias.kleine");
    await deleteAccounts(h.db, ["u-tobias.kleine"]);
    expect(await undo()).not.toContain("u-tobias.kleine");
    expect(await errorOf(undoPublish(h.db, viewer.userId, v!.id, cutoff))).toMatch(/lässt sich nicht mehr zurücknehmen/);
    expect((await cleanupVersions(h.db, new Date("2027-01-31T12:00:00Z"))).undoCleared).toBe(0);
    expect((await cleanupVersions(h.db, new Date("2027-02-01T03:00:00Z"))).undoCleared).toBe(1);
    expect((await getVersion(h.db, v!.id))!.undo).toBeNull();
  }, 120_000);
});
