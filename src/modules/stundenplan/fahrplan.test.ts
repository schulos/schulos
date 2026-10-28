// SP3-06 (docs/STUNDENPLAN-LEBENSZYKLUS.md §4): Planungsfahrplan – Status der acht Schritte rein aus Zahlen (`fahrplanStatus`), Checkliste,
// Quittierungen (`gateOf`, Schlüssel), Kennzahlen; auf der Demo-Schule: Lader, Quittieren als Bedingung fürs Veröffentlichen, Häkchen und
// Termine, Vorlage vermerkt, Übersicht mit Fahrplan statt Jahresplanung, Korrektur-Protokoll und Kontolöschung.
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { auditLog, timetableLessons, timetablePlanVersions, type TimetableLesson } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { deleteAccounts } from "@/core/privacy/konto";
import { ValidationError } from "@/modules/verwaltung/users";
import type { Finding } from "./diagnose";
import {
  acknowledgeOpenWarnings,
  acknowledgeWarnings,
  ACK_REASON_MAX,
  cleanAckReason,
  createEmptyFahrplan,
  fahrplanOffers,
  fahrplanStatus,
  gateOf,
  gateProblem,
  loadFahrplan,
  planKennzahlen,
  publishGate,
  readChecklist,
  revokeAcknowledgement,
  setStepDate,
  setTick,
  templateOf,
  warningKey,
  type Checklist,
  type FahrplanFacts,
} from "./fahrplan";
import { correctionLog } from "./korrekturprotokoll";
import { createFromTemplate } from "./laufzeit";
import { updateLesson, type LessonInput } from "./manage";
import { LIVE } from "./plan-quelle";
import { approveVersion, submitForReview, type Viewer } from "./planpruefung";
import { createDraft, getVersion } from "./planversionen";
import { correctionFrom } from "./sofortkorrektur";
import { planningOverview } from "./uebersicht";
import { publishVersion, undoPublish } from "./veroeffentlichen";

const errorOf = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof ValidationError) return Object.values(err.fieldErrors)[0]!;
    throw err;
  }
  throw new Error("keine ValidationError");
};

const warn = (id: string, message: string, category: Finding["category"] = "deputy"): Finding => ({
  category,
  severity: "warn",
  target: { kind: category === "deputy" ? "teacher" : "group", id, label: id },
  message,
});
const empty = (): Checklist => ({ acks: {}, ticks: {}, dates: {} });

/** Fakten eines Entwurfs, bei dem alles erledigt ist (Schritt 8: freigegeben, bereit). */
function goodFacts(over: Partial<FahrplanFacts> = {}): FahrplanFacts {
  return {
    version: { id: "v1", label: "2.0", name: "2. Halbjahr", status: "freigegeben", validFrom: "2027-02-01", validUntil: null, validFromIsSchoolDay: true, createdAt: new Date("2026-10-01T08:00:00Z") },
    year: { id: "sj", name: "2026/27", startsOn: "2026-08-01", endsOn: "2027-07-31" },
    schoolData: true,
    rahmen: { periods: 8 },
    personal: { activeTeachers: 30, withoutSubjects: 0, longAbsences: 0 },
    lerngruppen: { classes: 10, classesWithoutCurriculum: 0, emptyBands: 0, bands: 2, promoted: null },
    verteilung: { assignments: 200, classesBelowCurriculum: 0, withoutTeacher: 0, deputyOff: 0 },
    wuensche: { window: "closed", closesOn: "2026-10-01", submitted: 30, teachers: 30, roomBlocks: 1, fixed: 3 },
    setzen: { lessons: 300, openAssignments: 0, openHours: 0, lastRun: null },
    pruefen: {
      gate: gateOf([], {}),
      byCategory: [],
      diff: { changed: 3, added: 1, removed: 0, teachers: 2, groups: 2 },
      corrections: { actions: 0, lessons: 0 },
      variants: [],
      kennzahlen: { gaps: { teacherTotal: 4, teacherMax: 2, classTotal: 0, classMax: 0 }, edgeLessons: 20, wishesMet: 90, roomUse: 55.5 },
    },
    veroeffentlichen: { teacherPreview: true, openComments: 0, approved: true, undoUntil: null },
    ...over,
  };
}
const ticked = (): Checklist => ({ ...empty(), ticks: { prognose: { createdBy: "u", at: "x" }, sperren: { createdBy: "u", at: "x" } } });
const ampel = (f: ReturnType<typeof fahrplanStatus>) => Object.fromEntries(f.steps.map((s) => [s.step, s.ampel]));

describe("Planungsfahrplan rein (SP3-06)", () => {
  it("readChecklist liest nur Gültiges, Unbekanntes fällt weg", () => {
    expect(readChecklist(null)).toEqual(empty());
    expect(readChecklist("x")).toEqual(empty());
    const c = readChecklist({
      template: "halbjahr",
      acks: { a: { category: "deputy", teacherId: "t1", reason: "ok", createdBy: "u", at: "2026" }, b: { category: "nope", reason: "x" }, c: { category: "room" } },
      ticks: { sperren: { createdBy: "u", at: "t" }, foo: {} },
      dates: { rahmen: "2026-11-01", setzen: "kein Datum", unbekannt: "2026-11-01" },
    });
    expect(c.template).toBe("halbjahr");
    expect(Object.keys(c.acks)).toEqual(["a"]);
    expect(c.acks.a).toMatchObject({ category: "deputy", teacherId: "t1", reason: "ok" });
    expect(Object.keys(c.ticks)).toEqual(["sperren"]);
    expect(c.dates).toEqual({ rahmen: "2026-11-01" });
    expect(readChecklist({ template: "anders" }).template).toBeUndefined();
  });

  it("Schlüssel einer Warnung: stabil, ändert sich mit Text oder Bezug, ohne den Text zu enthalten", () => {
    const a = warn("t1", "2,5 Stunden unter Soll");
    expect(warningKey(a)).toBe(warningKey({ ...a }));
    expect(warningKey(a)).not.toBe(warningKey(warn("t1", "3 Stunden unter Soll")));
    expect(warningKey(a)).not.toBe(warningKey(warn("t2", "2,5 Stunden unter Soll")));
    expect(warningKey(a)).toMatch(/^[0-9a-f]{24}$/);
  });

  it("gateOf: Fehler blockieren immer, Warnungen bis zur Quittierung; Hinweise zählen nicht; nicht mehr aktuelle Quittierungen", () => {
    const w1 = warn("t1", "A");
    const w2 = warn("g1", "B", "room");
    const info: Finding = { ...warn("t3", "C"), severity: "info" };
    const err: Finding = { ...warn("t4", "D"), severity: "error" };
    const g0 = gateOf([w1, w2, w1, info], {});
    expect(g0).toMatchObject({ open: 2, stale: 0, ok: false });
    expect(g0.warnings).toHaveLength(2);
    const ack = { category: "deputy" as const, reason: "bekannt", createdBy: "u", at: "x" };
    const g1 = gateOf([w1, w2], { [warningKey(w1)]: ack, [warningKey(w2)]: ack, alt: ack });
    expect(g1).toMatchObject({ open: 0, stale: 1, ok: true });
    expect(gateProblem(g1)).toBeNull();
    const g2 = gateOf([w1, err], { [warningKey(w1)]: ack });
    expect(g2).toMatchObject({ open: 0, ok: false });
    expect(gateProblem(g2)).toMatch(/1 Fehler/);
    expect(gateProblem(gateOf([w1, w2], {}))).toMatch(/2 Warnungen nicht quittiert.*Schritt 7/);
  });

  it("Begründung: Pflicht, höchstens 120 Zeichen, Leerraum zusammengefasst", async () => {
    expect(await errorOf(() => cleanAckReason("   "))).toMatch(/Begründung/);
    expect(await errorOf(() => cleanAckReason("x".repeat(ACK_REASON_MAX + 1)))).toMatch(/120/);
    expect(cleanAckReason("  zwei   Wörter ")).toBe("zwei Wörter");
  });

  it("Kennzahlen: Hohlstunden, Randstunden, erfüllte Wünsche, Raumauslastung", () => {
    const l = (groupId: string, teacherId: string | null, roomId: string | null, weekday: number, periodNr: number) => ({ groupId, teacherId, roomId, weekday, periodNr });
    const lessons = [l("k1", "t1", "101", 0, 1), l("k1", "t1", "101", 0, 3), l("k2", "t2", "102", 0, 8), l("k2", "t2", null, 1, 2)];
    const prefs = new Map([
      ["t1", new Map<string, number | null>([["0-1", null], ["0-2", -2], ["0-4", 3]])],
      ["t2", new Map<string, number | null>([["1-2", -1]])],
    ]);
    const k = planKennzahlen(lessons, { periodNrs: [1, 2, 3, 4, 5, 6, 7, 8], classIds: new Set(["k1", "k2"]), teacherPrefs: prefs, activeRooms: 2 });
    expect(k.gaps).toMatchObject({ teacherTotal: 1, teacherMax: 1, classTotal: 1, classMax: 1 });
    expect(k.edgeLessons).toBe(2); // 1. und 8. Stunde
    // drei „nicht“-Wünsche (gesperrt, −2, −1), davon einer frei (0-2): 33,3 %
    expect(k.wishesMet).toBe(33.3);
    expect(k.roomUse).toBe(Math.round((3 / (2 * 5 * 8)) * 1000) / 10);
    expect(planKennzahlen([], { periodNrs: [], classIds: new Set(), teacherPrefs: new Map(), activeRooms: 0 })).toMatchObject({ edgeLessons: 0, wishesMet: null, roomUse: null });
  });

  it("alles erledigt: 7 Schritte grün, Schritt 8 gelb (bereit) – erst nach dem Veröffentlichen grün", () => {
    const f = fahrplanStatus(goodFacts(), ticked(), "2026-10-20");
    expect(ampel(f)).toEqual({ rahmen: "gruen", personal: "gruen", lerngruppen: "gruen", verteilung: "gruen", wuensche: "gruen", setzen: "gruen", pruefen: "gruen", veroeffentlichen: "gelb" });
    expect(f.done).toBe(7);
    expect(f.next).toBe("veroeffentlichen");
    expect(f.steps.map((s) => s.nr)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const links = f.steps.find((s) => s.step === "veroeffentlichen")!.links.map((x) => x.href);
    expect(links).toContain("/planung/versionen/veroeffentlichen?version=v1");
    const published = fahrplanStatus(goodFacts({ version: { ...goodFacts().version, status: "gueltig" }, veroeffentlichen: { ...goodFacts().veroeffentlichen, undoUntil: "2027-01-31" } }), ticked(), "2026-10-20");
    expect(published.done).toBe(8);
    expect(published.next).toBeNull();
    expect(published.steps.at(-1)!.points[0]!.text).toMatch(/Rücknahme bis 2027-01-31/);
  });

  it("jeder Schritt wird rot aus seinen Daten", () => {
    const g = goodFacts();
    const red = (over: Partial<FahrplanFacts>, step: string, c: Checklist = ticked()) => {
      const s = fahrplanStatus(goodFacts(over), c, "2026-10-20").steps.find((x) => x.step === step)!;
      expect(s.ampel, step).toBe("rot");
      return s;
    };
    expect(red({ rahmen: { periods: 0 } }, "rahmen").open).toBe(1);
    red({ version: { ...g.version, validFromIsSchoolDay: false } }, "rahmen");
    red({ version: { ...g.version, validFrom: null } }, "rahmen");
    expect(red({ personal: { ...g.personal, withoutSubjects: 3 } }, "personal").points.some((p) => p.text.startsWith("3 Lehrkräfte ohne Lehrfach"))).toBe(true);
    red({}, "personal", { ...empty(), ticks: { sperren: { createdBy: "u", at: "x" } } }); // Prognose nicht abgehakt
    red({ lerngruppen: { ...g.lerngruppen, classes: 0 } }, "lerngruppen");
    red({ lerngruppen: { ...g.lerngruppen, classesWithoutCurriculum: 1 } }, "lerngruppen");
    red({ lerngruppen: { ...g.lerngruppen, emptyBands: 1 } }, "lerngruppen");
    red({ verteilung: { ...g.verteilung, classesBelowCurriculum: 2 } }, "verteilung");
    red({ verteilung: { ...g.verteilung, withoutTeacher: 1 } }, "verteilung");
    red({ wuensche: { ...g.wuensche, window: "open", closesOn: "2026-10-30" } }, "wuensche");
    red({ wuensche: { ...g.wuensche, submitted: 29 } }, "wuensche");
    red({}, "wuensche", { ...empty(), ticks: { prognose: { createdBy: "u", at: "x" } } }); // Sperren nicht geprüft
    red({ setzen: { ...g.setzen, openHours: 4, openAssignments: 2 } }, "setzen");
    red({ pruefen: { ...g.pruefen, gate: gateOf([warn("t1", "x")], {}) } }, "pruefen");
    red({ version: { ...g.version, status: "entwurf" } }, "veroeffentlichen");
    red({ version: { ...g.version, status: "pruefung" } }, "veroeffentlichen");
    // freigegeben, aber Schritt 7 offen → Schritt 8 rot
    red({ pruefen: { ...g.pruefen, gate: gateOf([warn("t1", "x")], {}) } }, "veroeffentlichen");
  });

  it("Hinweise statt offen: Deputate außerhalb ±0,5, lange Abwesenheiten, Sofort-Korrekturen, Frist vorbei, kein Fenster", () => {
    const g = goodFacts();
    const f = fahrplanStatus(
      goodFacts({
        verteilung: { ...g.verteilung, deputyOff: 5 },
        personal: { ...g.personal, longAbsences: 1 },
        pruefen: { ...g.pruefen, corrections: { actions: 3, lessons: 4 } },
        wuensche: { ...g.wuensche, window: "open", closesOn: "2026-10-10", submitted: 30 },
      }),
      ticked(),
      "2026-10-20",
    );
    const by = Object.fromEntries(f.steps.map((s) => [s.step, s]));
    expect(by.verteilung!.ampel).toBe("gelb");
    expect(by.personal!.ampel).toBe("gelb");
    expect(by.pruefen!.ampel).toBe("gelb");
    expect(by.pruefen!.points.some((p) => p.text.includes("3 Sofort-Korrekturen"))).toBe(true);
    expect(by.pruefen!.links.map((l) => l.label)).toContain("Korrektur-Protokoll");
    expect(by.wuensche!.ampel).toBe("gruen"); // Frist vorbei zählt wie geschlossen
    const none = fahrplanStatus(goodFacts({ wuensche: { ...g.wuensche, window: "none", closesOn: null, submitted: 0 } }), ticked(), "2026-10-20");
    expect(none.steps.find((s) => s.step === "wuensche")!.ampel).toBe("gruen");
  });

  it("Vorlagen: „Änderung“ klappt 2–5 ein, „Neues Schuljahr“ verlangt die Versetzung (Erweiterungspunkt SP3-07); Termine und überfällig", () => {
    const c: Checklist = { ...ticked(), template: "aenderung", dates: { setzen: "2026-10-19", rahmen: "2026-10-01", pruefen: "2026-12-01" } };
    const f = fahrplanStatus(goodFacts({ setzen: { ...goodFacts().setzen, openHours: 1, openAssignments: 1 } }), c, "2026-10-20", templateOf({ minor: 0 }, c));
    expect(f.steps.filter((s) => s.collapsed).map((s) => s.step)).toEqual(["personal", "lerngruppen", "verteilung", "wuensche"]);
    const by = Object.fromEntries(f.steps.map((s) => [s.step, s]));
    expect(by.setzen).toMatchObject({ due: "2026-10-19", overdue: true });
    expect(by.rahmen).toMatchObject({ due: "2026-10-01", overdue: false }); // erledigt → nicht überfällig
    expect(by.pruefen).toMatchObject({ due: "2026-12-01", overdue: false });
    expect(templateOf({ minor: 1 }, empty())).toBe("aenderung");
    expect(templateOf({ minor: 0 }, empty())).toBeNull();
    const sj = (promoted: boolean | null) => fahrplanStatus(goodFacts({ lerngruppen: { ...goodFacts().lerngruppen, promoted } }), ticked(), "2026-10-20", "schuljahr").steps.find((s) => s.step === "lerngruppen")!;
    expect(sj(null).ampel).toBe("rot");
    expect(sj(false).ampel).toBe("rot");
    expect(sj(true).ampel).toBe("gruen");
    expect(sj(null).links.map((l) => l.href)).toContain("/verwaltung/schuljahreswechsel");
  });
});

describe("Planungsfahrplan auf der Demo-Schule (SP3-06)", () => {
  let h: DbHandle;
  const today = "2026-10-05"; // Montag
  const now = new Date("2026-10-05T08:00:00Z");
  const yearId = "sj-2026-27";
  const cutoff = "2027-02-01";
  const viewer: Viewer = { userId: "u-frank.schulte", manage: true, review: true };
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 120_000);
  afterAll(() => h.close());

  const approve = async (id: string) => {
    await submitForReview(h.db, viewer, id, now);
    await approveVersion(h.db, viewer, id, now);
  };

  it("Lader: Status aus den Daten; Quittieren ist Bedingung fürs Veröffentlichen; Häkchen, Termine, Audit ohne Begründung", async () => {
    // ohne Entwurf: Übersicht mit Jahresplanung, kein Fahrplan
    const before = await planningOverview(h.db, today, { manage: true, substitute: false });
    expect(before.fahrplan).toBeNull();
    expect(before.manage).not.toBeNull();

    const v = await createFromTemplate(h.db, viewer.userId, yearId, "halbjahr", today);
    expect(readChecklist(v.checklist).template).toBe("halbjahr");
    const l = await loadFahrplan(h.db, v, today);
    expect(l.fahrplan.template).toBe("halbjahr");
    expect(l.facts.version).toMatchObject({ validFrom: cutoff, validFromIsSchoolDay: true, status: "entwurf" });
    expect(l.facts.rahmen.periods).toBeGreaterThan(0);
    expect(l.facts.lerngruppen.classes).toBeGreaterThan(0);
    expect(l.facts.setzen.lessons).toBeGreaterThan(0);
    // Demo: keine Fehler, aber Warnungen (Raumgröße, Deputate) → Schritt 7 rot, Schritt 8 rot (noch Entwurf)
    const gate = l.facts.pruefen.gate;
    expect(gate.errors).toHaveLength(0);
    expect(gate.warnings.length).toBeGreaterThan(0);
    expect(gate.open).toBe(gate.warnings.length);
    const step = (x: typeof l, s: string) => x.fahrplan.steps.find((y) => y.step === s)!;
    expect(step(l, "pruefen").ampel).toBe("rot");
    expect(step(l, "veroeffentlichen").ampel).toBe("rot");
    expect(l.facts.pruefen.diff).toMatchObject({ changed: 0, added: 0, removed: 0 });
    expect(l.facts.pruefen.kennzahlen.roomUse).toBeGreaterThan(0);

    // Übersicht: Fahrplan statt Jahresplanung
    const o = await planningOverview(h.db, today, { manage: true, substitute: false });
    expect(o.manage).toBeNull();
    expect(o.fahrplan).toMatchObject({ versionId: v.id, label: "2.0", otherDrafts: 0 });
    expect(o.fahrplan!.steps).toHaveLength(8);

    // freigeben – Veröffentlichen scheitert an Schritt 7
    await approve(v.id);
    expect(await errorOf(publishVersion(h.db, viewer.userId, v.id, cutoff, today, now))).toMatch(/Schritt 7/);

    // eine Kategorie quittieren (Begründung Pflicht), eine Warnung zurücknehmen
    const deputy = gate.warnings.filter((w) => w.finding.category === "deputy");
    const room = gate.warnings.filter((w) => w.finding.category === "room");
    expect(deputy.length).toBeGreaterThan(0);
    expect(room.length).toBeGreaterThan(0);
    expect(await errorOf(acknowledgeWarnings(h.db, viewer.userId, v.id, deputy.map((w) => w.key), "  ", today))).toMatch(/Begründung/);
    expect(await errorOf(acknowledgeWarnings(h.db, viewer.userId, v.id, ["gibt-es-nicht"], "egal", today))).toMatch(/aktuelle Warnung/);
    expect(await acknowledgeWarnings(h.db, viewer.userId, v.id, deputy.map((w) => w.key), "Teilzeit und Abordnungen, mit SL abgestimmt", today)).toBe(deputy.length);
    let g2 = await publishGate(h.db, (await getVersion(h.db, v.id))!, today);
    expect(g2.open).toBe(room.length);
    expect(await acknowledgeOpenWarnings(h.db, viewer.userId, v.id, "Kursgröße schwankt, Raum reicht", today, { category: "room" })).toBe(room.length);
    g2 = await publishGate(h.db, (await getVersion(h.db, v.id))!, today);
    expect(g2.ok).toBe(true);
    await revokeAcknowledgement(h.db, viewer.userId, v.id, room[0]!.key);
    expect(await errorOf(publishVersion(h.db, viewer.userId, v.id, cutoff, today, now))).toMatch(/1 Warnung nicht quittiert/);
    await acknowledgeOpenWarnings(h.db, viewer.userId, v.id, "Kursgröße schwankt, Raum reicht", today);

    // Häkchen und Termine (auch in „freigegeben“ – der Inhalt bleibt unberührt, die Freigabe auch)
    await setTick(h.db, viewer.userId, v.id, "sperren", true, now);
    await setTick(h.db, viewer.userId, v.id, "prognose", true, now);
    await setTick(h.db, viewer.userId, v.id, "prognose", false, now);
    await setStepDate(h.db, viewer.userId, v.id, "setzen", "2026-12-01");
    expect(await errorOf(setStepDate(h.db, viewer.userId, v.id, "setzen", "2027-13-01"))).toMatch(/Datum/);
    expect(await errorOf(setStepDate(h.db, viewer.userId, v.id, "setzen", "2028-01-01"))).toMatch(/Schuljahrs/);
    const v2 = (await getVersion(h.db, v.id))!;
    expect(v2.status).toBe("freigegeben");
    const c = readChecklist(v2.checklist);
    expect(Object.keys(c.ticks)).toEqual(["sperren"]);
    expect(c.dates).toEqual({ setzen: "2026-12-01" });
    expect(Object.values(c.acks).every((a) => a.createdBy === viewer.userId && a.reason.length <= 120)).toBe(true);
    expect(Object.values(c.acks).filter((a) => a.category === "deputy").every((a) => typeof a.teacherId === "string")).toBe(true);
    const l2 = await loadFahrplan(h.db, v2, today);
    expect(step(l2, "pruefen").ampel).toBe("gruen");
    expect(step(l2, "veroeffentlichen").ampel).toBe("gelb");

    // Audit: Zahlen und Kategorien, nie die Begründung
    const audits = await h.db.select().from(auditLog).where(eq(auditLog.target, v.id)).orderBy(asc(auditLog.createdAt));
    const acks = audits.filter((a) => a.action === "stundenplan.plan.acknowledge");
    expect(acks.length).toBe(3);
    expect(JSON.stringify(audits)).not.toMatch(/Teilzeit|Kursgröße/);
    expect(audits.some((a) => a.action === "stundenplan.plan.acknowledge_revoke")).toBe(true);
    expect(audits.filter((a) => a.action === "stundenplan.plan.checklist").length).toBe(4);

    // veröffentlichen geht jetzt; danach ist die Checkliste abgeschlossen
    await publishVersion(h.db, viewer.userId, v.id, cutoff, today, now);
    const pub = (await getVersion(h.db, v.id))!;
    expect(await errorOf(setTick(h.db, viewer.userId, v.id, "sperren", false, now))).toMatch(/nicht mehr offen/);
    const l3 = await loadFahrplan(h.db, pub, today);
    expect(l3.fahrplan.done).toBeGreaterThanOrEqual(2);
    expect(step(l3, "veroeffentlichen")).toMatchObject({ ampel: "gruen" });
    expect(l3.facts.veroeffentlichen.undoUntil).toBe("2027-01-31");
    // Übersicht: kein offener Entwurf mehr → wieder Jahresplanung
    expect((await planningOverview(h.db, today, { manage: true, substitute: false })).fahrplan).toBeNull();
    await undoPublish(h.db, viewer.userId, v.id, today);
  }, 240_000);

  it("Sofort-Korrekturen seit Entwurfsbeginn in Schritt 7; Korrektur-Protokoll je Aktion; leerer Entwurf und Vorlagen-Angebote", async () => {
    const offers = await fahrplanOffers(h.db, { id: yearId, startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: cutoff }, today);
    expect(offers.aenderung.ok).toBe(true);
    expect(offers.schuljahr).toMatchObject({ ok: false, reason: expect.stringContaining("nächste Schuljahr") }); // Demo: kein Folgejahr
    expect(offers.leer).toMatchObject({ ok: true });

    const v = await createDraft(h.db, viewer.userId, { schoolYearId: yearId, source: "live_copy", validFrom: cutoff, numbering: "major", name: "Variante B" }, today);
    const from = await correctionFrom(h.db, today);
    const [l] = await h.db
      .select()
      .from(timetableLessons)
      .where(and(eq(timetableLessons.groupId, "g-7b"), eq(timetableLessons.weekday, 0), eq(timetableLessons.periodNr, 5)))
      .orderBy(asc(timetableLessons.validFrom), asc(timetableLessons.id));
    const lesson = l as TimetableLesson;
    const target = lesson.roomId === "105" ? "106" : "105";
    const input: LessonInput = { groupId: lesson.groupId, weekday: lesson.weekday, periodNr: lesson.periodNr, subjectId: lesson.subjectId, teacherId: lesson.teacherId, roomId: target, week: lesson.week, validFrom: lesson.validFrom, validUntil: lesson.validUntil };
    await updateLesson(h.db, viewer.userId, lesson.id, input, LIVE, { today, now: new Date(), batchId: "b-fahrplan", reason: "Raumtausch Wasserschaden" });
    const loaded = await loadFahrplan(h.db, (await getVersion(h.db, v.id))!, today);
    expect(loaded.facts.pruefen.corrections).toMatchObject({ actions: 1, lessons: 1 });
    const log = await correctionLog(h.db, yearId);
    const b = log.batches.find((x) => x.batchId === "b-fahrplan")!;
    expect(b).toMatchObject({ validFrom: from, reason: "Raumtausch Wasserschaden", versionLabel: "1.0", kinds: { split: 1, inplace: 0, delete: 0, create: 0 } });
    expect(b.actor).toBeTruthy();
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toContain(`→ ${target}`);
    expect(log.truncated).toBe(false);

    // leerer Entwurf: neue Planung, nur fixierte Stunden, Vorlage vermerkt; die Übersicht zeigt den neuesten und nennt die anderen
    // (2.0 „2. Halbjahr“ ist nach der Rücknahme wieder freigegeben, dazu „Variante B“)
    const leer = await createEmptyFahrplan(h.db, viewer.userId, { id: yearId, startsOn: "2026-08-01", endsOn: "2027-07-31", term2StartsOn: cutoff }, today);
    expect(readChecklist(leer.checklist).template).toBe("leer");
    const o = await planningOverview(h.db, today, { manage: true, substitute: false });
    expect(o.fahrplan).toMatchObject({ versionId: leer.id, otherDrafts: 2 });
  }, 240_000);

  it("Kontolöschung: Quittierungen und Häkchen verlieren die Kennung der Person und der Lehrkraft", async () => {
    const [v] = await h.db.select().from(timetablePlanVersions).where(eq(timetablePlanVersions.name, "Variante B"));
    await acknowledgeOpenWarnings(h.db, "u-jana.brandt", v!.id, "von BRA geprüft", today, { category: "deputy" });
    await setTick(h.db, "u-jana.brandt", v!.id, "sperren", true, now);
    const before = JSON.stringify((await getVersion(h.db, v!.id))!.checklist);
    expect(before).toContain("u-jana.brandt");
    await deleteAccounts(h.db, ["u-jana.brandt"]);
    const after = JSON.stringify((await getVersion(h.db, v!.id))!.checklist);
    expect(after).not.toContain("u-jana.brandt");
    expect(after).not.toMatch(/\bBRA\b/);
    expect(after).toContain("gelöschte Lehrkraft");
  }, 120_000);
});
