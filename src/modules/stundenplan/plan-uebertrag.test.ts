// SP3-04 (R1-Gegenmaßnahme): reine Regeln des Veröffentlichens als Tabellen-Tests auf dem Demo-Plan – Diff mit Zeitraum und Kopplung
// (`transferPlan`), Übertrag von Vertretungen/Material/Klassenbuch (`transferRefs`), Änderungsliste (`changeLine`/`changeLists`).
import { asc } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { changeLine, changeLists, holdsOn, planMessage, transferPlan, transferRefs, type RefDated, type RefSubstitution, type TransferLesson } from "./plan-uebertrag";

const from = "2027-02-01"; // Montag, Beginn 2. Halbjahr der Demo-Schule
const yearEnd = "2027-07-31";

let live: TransferLesson[] = [];
beforeAll(async () => {
  const h = await createSeededTestDb();
  const rows = await h.db.select().from(timetableLessons).orderBy(asc(timetableLessons.id));
  live = rows.map((r) => ({
    id: r.id,
    groupId: r.groupId,
    subjectId: r.subjectId,
    teacherId: r.teacherId,
    roomId: r.roomId,
    weekday: r.weekday,
    periodNr: r.periodNr,
    week: r.week,
    couplingId: r.couplingId,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
    fixed: r.fixed,
    solverRunId: r.solverRunId,
  }));
  await h.close();
}, 120_000);

/** Entwurf wie „aus dem gültigen Plan ab Stichtag“: Kopie mit Herkunft, Beginn frühestens am Stichtag. */
const liveCopy = (): TransferLesson[] => live.map((l) => ({ ...l, id: `d-${l.id}`, originLessonId: l.id, validFrom: l.validFrom < from ? from : l.validFrom }));
const lessonOf = (group: string, weekday: number, period: number) => live.find((l) => l.groupId === group && l.weekday === weekday && l.periodNr === period)!;
let seq = 0;
const ids = () => `neu-${++seq}`;

describe("transferPlan (rein, Demo-Plan)", () => {
  // 7b: Mo 5. Deutsch (BRA, 106), Mi 1. Deutsch; Q1-Band Mo 4. (BI/D/E gekoppelt)
  type Case = { name: string; edit: (draft: TransferLesson[]) => TransferLesson[]; expect: (p: ReturnType<typeof transferPlan>) => void };
  const cases: Case[] = [
    {
      name: "unveränderte Kopie: alle Stunden bleiben (ids, nichts endet, nichts neu)",
      edit: (d) => d,
      expect: (p) => {
        expect(p.counts).toEqual({ unchanged: live.length, changed: 0, added: 0, removed: 0 });
        expect(p.kept).toHaveLength(live.length);
        expect(p.created).toEqual([]);
        expect(p.ended).toEqual([]);
      },
    },
    {
      name: "anderer Raum: alte Zeile endet am Vortag, Nachfolgerin am selben Wochentag ab Stichtag",
      edit: (d) => d.map((x) => (x.originLessonId === lessonOf("g-7b", 0, 5).id ? { ...x, roomId: "105" } : x)),
      expect: (p) => {
        const old = lessonOf("g-7b", 0, 5);
        expect(p.counts).toMatchObject({ unchanged: live.length - 1, changed: 1, added: 0, removed: 0 });
        expect(p.ended).toEqual([{ id: old.id, validUntil: old.validUntil }]);
        const s = p.successor.get(old.id)!;
        expect(s).toMatchObject({ predecessorId: old.id, roomId: "105", weekday: 0, periodNr: 5, validFrom: from, validUntil: yearEnd, couplingId: null });
        expect(p.kept).not.toContain(old.id);
      },
    },
    {
      name: "Stunde fällt weg: entfällt (endet), ohne Nachfolgerin",
      edit: (d) => d.filter((x) => x.originLessonId !== lessonOf("g-7b", 2, 1).id),
      expect: (p) => {
        expect(p.counts).toMatchObject({ removed: 1, changed: 0, added: 0 });
        expect(p.successor.size).toBe(0);
        expect(p.ended.map((e) => e.id)).toEqual([lessonOf("g-7b", 2, 1).id]);
      },
    },
    {
      name: "neue Stunde ohne Herkunft: neu, ab Stichtag bis Entwurfsende (höchstens Schuljahresende)",
      edit: (d) => [...d, { ...d[0]!, id: "d-neu", originLessonId: null, groupId: "g-7b", weekday: 4, periodNr: 7, couplingId: null, validFrom: "2027-01-04", validUntil: null }],
      expect: (p) => {
        expect(p.counts).toMatchObject({ added: 1, changed: 0, removed: 0 });
        expect(p.created).toEqual([expect.objectContaining({ draftId: "d-neu", predecessorId: null, validFrom: from, validUntil: yearEnd })]);
      },
    },
    {
      name: "verschoben auf einen anderen Tag: geändert (Zeit), Nachfolgerin am neuen Tag",
      edit: (d) => d.map((x) => (x.originLessonId === lessonOf("g-7b", 1, 3).id ? { ...x, weekday: 4, periodNr: 7 } : x)),
      expect: (p) => {
        const s = p.successor.get(lessonOf("g-7b", 1, 3).id)!;
        expect(s).toMatchObject({ weekday: 4, periodNr: 7 });
        expect(p.counts.changed).toBe(1);
      },
    },
    {
      name: "Kopplung als Einheit: ändert sich ein Teil des Bands, bekommen alle Teile neue Zeilen mit einer neuen gemeinsamen Kopplungs-id",
      edit: (d) => {
        const band = lessonOf("g-q1-bi-gk1", 0, 4);
        return d.map((x) => (x.originLessonId === band.id ? { ...x, roomId: "NW2" } : x));
      },
      expect: (p) => {
        const band = lessonOf("g-q1-bi-gk1", 0, 4);
        const parts = live.filter((l) => l.couplingId === band.couplingId);
        expect(parts.length).toBeGreaterThan(1);
        expect(p.counts.changed).toBe(parts.length);
        expect(p.changedWithCoupling).toBe(parts.length - 1);
        const succ = parts.map((x) => p.successor.get(x.id)!);
        expect(new Set(succ.map((s) => s.couplingId)).size).toBe(1);
        expect(succ[0]!.couplingId).not.toBe(band.couplingId);
        expect(succ[0]!.couplingId).not.toBeNull();
      },
    },
    {
      name: "nur der Zeitraum anders (endet früher): geändert, Ende aus dem Entwurf",
      edit: (d) => d.map((x) => (x.originLessonId === lessonOf("g-7b", 3, 3).id ? { ...x, validUntil: "2027-03-31" } : x)),
      expect: (p) => {
        expect(p.counts.changed).toBe(1);
        expect(p.changedTiming).toBe(1);
        expect(p.successor.get(lessonOf("g-7b", 3, 3).id)).toMatchObject({ validFrom: from, validUntil: "2027-03-31" });
      },
    },
    {
      name: "A/B-Woche: Woche geändert ist eine Änderung",
      edit: (d) => d.map((x) => (x.originLessonId === lessonOf("g-7b", 0, 1).id ? { ...x, week: "A" } : x)),
      expect: (p) => expect(p.successor.get(lessonOf("g-7b", 0, 1).id)).toMatchObject({ week: "A" }),
    },
  ];
  it.each(cases)("$name", ({ edit, expect: check }) => {
    check(transferPlan({ live, draft: edit(liveCopy()), from, yearEnd }, ids));
  });

  it("Stunden, die erst ab dem Stichtag begannen, werden gelöscht statt beendet; unbefristet und „bis Schuljahresende“ sind gleich", () => {
    const later: TransferLesson = { ...live[0]!, id: "spaet", weekday: 4, periodNr: 8, couplingId: null, validFrom: "2027-03-01", validUntil: null };
    const open: TransferLesson = { ...live[1]!, id: "offen", weekday: 4, periodNr: 9, couplingId: null, validFrom: "2026-08-01", validUntil: null };
    const draft = [...liveCopy(), { ...open, id: "d-offen", originLessonId: "offen", validFrom: from, validUntil: yearEnd }];
    const p = transferPlan({ live: [...live, later, open], draft, from, yearEnd }, ids);
    expect(p.deleted).toEqual(["spaet"]);
    expect(p.kept).toContain("offen");
    expect(p.counts).toMatchObject({ removed: 1, changed: 0 });
  });

  it("Stunden, die vor dem Stichtag enden, zählen nicht; Entwurfsstunden ohne Zeit ab dem Stichtag auch nicht", () => {
    const ended: TransferLesson = { ...live[0]!, id: "alt", validFrom: "2026-08-01", validUntil: "2027-01-31" };
    const draftOld: TransferLesson = { ...live[0]!, id: "d-alt", validFrom: "2026-08-01", validUntil: "2027-01-15" };
    const p = transferPlan({ live: [...live, ended], draft: [...liveCopy(), draftOld], from, yearEnd }, ids);
    expect(p.counts).toEqual({ unchanged: live.length, changed: 0, added: 0, removed: 0 });
  });
});

describe("transferRefs (rein, Demo-Plan)", () => {
  const d = (ymd: string) => ymd;
  // 2027-02-01 Mo (KW 5, A-Woche), 2027-02-08 Mo (KW 6, B-Woche), 2027-01-25 Mo (vor dem Stichtag)
  it("Tabelle: umziehen, wenn die Nachfolgerin an dem Tag stattfindet – sonst gesichert/gelöscht bzw. ohne Bezug", () => {
    const room = lessonOf("g-7b", 0, 5); // Mo 5., Raum ändert sich
    const moved = lessonOf("g-7b", 1, 3); // Di 3. → Fr 7.
    const ab = lessonOf("g-7b", 0, 1); // Mo 1. → nur A-Woche
    const gone = lessonOf("g-7b", 2, 1); // Mi 1. entfällt
    const keep = lessonOf("g-7b", 0, 6); // Mo 6. bleibt
    const draft = liveCopy()
      .filter((x) => x.originLessonId !== gone.id)
      .map((x) =>
        x.originLessonId === room.id ? { ...x, roomId: "105" } : x.originLessonId === moved.id ? { ...x, weekday: 4, periodNr: 7 } : x.originLessonId === ab.id ? { ...x, week: "A" as const } : x,
      );
    const p = transferPlan({ live, draft, from, yearEnd }, ids);
    const goneSet = new Set([...p.ended.map((e) => e.id), ...p.deleted]);
    const keptLessons = new Map(live.filter((l) => !goneSet.has(l.id)).map((l) => [l.id, { periodNr: l.periodNr }]));
    const subs: RefSubstitution[] = [
      { id: "s-raum", lessonId: room.id, date: d("2027-02-01"), kind: "cancel", targetPeriod: null, mergeLessonId: null },
      { id: "s-vorher", lessonId: room.id, date: d("2027-01-25"), kind: "cancel", targetPeriod: null, mergeLessonId: null },
      { id: "s-tag", lessonId: moved.id, date: d("2027-02-02"), kind: "substitute", targetPeriod: null, mergeLessonId: null },
      { id: "s-a", lessonId: ab.id, date: d("2027-02-01"), kind: "room", targetPeriod: null, mergeLessonId: null },
      { id: "s-b", lessonId: ab.id, date: d("2027-02-08"), kind: "room", targetPeriod: null, mergeLessonId: null },
      { id: "s-weg", lessonId: gone.id, date: d("2027-02-03"), kind: "cancel", targetPeriod: null, mergeLessonId: null },
      { id: "s-bleibt", lessonId: keep.id, date: d("2027-02-01"), kind: "cancel", targetPeriod: null, mergeLessonId: null },
      // Verlegung in die 5. Stunde: die neue Stunde liegt selbst in der 5. → zieht nicht mit; in die 2. → zieht mit
      { id: "s-verl-ok", lessonId: room.id, date: d("2027-02-15"), kind: "move", targetPeriod: 2, mergeLessonId: null },
      // Zusammenlegung der unveränderten Mo 6. in die geänderte Mo 5. – andere Stunde → entfällt; gleiche Stunde wäre Umzug
      { id: "s-zus", lessonId: keep.id, date: d("2027-02-22"), kind: "merge", targetPeriod: null, mergeLessonId: room.id },
    ];
    const materials: RefDated[] = [
      { id: "m-raum", lessonId: room.id, date: d("2027-02-01") },
      { id: "m-weg", lessonId: gone.id, date: d("2027-02-03") },
    ];
    const classbook: RefDated[] = [
      { id: "k-vorher", lessonId: room.id, date: d("2027-01-25") },
      { id: "k-raum", lessonId: room.id, date: d("2027-02-01") },
      { id: "k-weg", lessonId: gone.id, date: d("2027-02-03") },
    ];
    const r = transferRefs({ from, kept: p.kept, successor: p.successor, gone: goneSet }, keptLessons, { substitutions: subs, materials, classbook });
    const succ = (id: string) => p.successor.get(id)!.id;
    expect(r.substitutionMoves).toEqual([
      { id: "s-raum", lessonId: { from: room.id, to: succ(room.id) } },
      { id: "s-a", lessonId: { from: ab.id, to: succ(ab.id) } },
      { id: "s-verl-ok", lessonId: { from: room.id, to: succ(room.id) } },
    ]);
    expect(r.substitutionsRemoved.sort()).toEqual(["s-b", "s-tag", "s-weg", "s-zus"].sort());
    expect(r.materialMoves).toEqual([{ id: "m-raum", from: room.id, to: succ(room.id) }]);
    expect(r.materialsRemoved).toEqual(["m-weg"]);
    expect(r.classbookMoves).toEqual([{ id: "k-raum", from: room.id, to: succ(room.id) }]);
    expect(r.classbookDetached).toEqual([{ id: "k-weg", lessonId: gone.id }]);
  });

  it("Zusammenlegung und Verlegung: nur, wenn beide Stunden an dem Tag in derselben Stunde liegen bzw. die Zielstunde nicht die neue Stunde ist", () => {
    // Q1-Band Mo 4. (BI/D/E gekoppelt): BI ändert den Raum → alle Teile neu; eine Zusammenlegung D → BI zieht auf beide Nachfolgerinnen
    const bi = lessonOf("g-q1-bi-gk1", 0, 4);
    const de = lessonOf("g-q1-d-gk1", 0, 4);
    const room = lessonOf("g-7b", 0, 5);
    const draft = liveCopy().map((x) => (x.originLessonId === bi.id ? { ...x, roomId: "NW2" } : x.originLessonId === room.id ? { ...x, roomId: "105" } : x));
    const p = transferPlan({ live, draft, from, yearEnd }, ids);
    const goneSet = new Set([...p.ended.map((e) => e.id), ...p.deleted]);
    const keptLessons = new Map(live.filter((l) => !goneSet.has(l.id)).map((l) => [l.id, { periodNr: l.periodNr }]));
    const r = transferRefs({ from, kept: p.kept, successor: p.successor, gone: goneSet }, keptLessons, {
      substitutions: [
        { id: "zus", lessonId: de.id, date: "2027-02-01", kind: "merge", targetPeriod: null, mergeLessonId: bi.id },
        { id: "verl", lessonId: room.id, date: "2027-02-01", kind: "move", targetPeriod: 5, mergeLessonId: null },
      ],
      materials: [],
      classbook: [],
    });
    expect(r.substitutionMoves).toEqual([{ id: "zus", lessonId: { from: de.id, to: p.successor.get(de.id)!.id }, mergeLessonId: { from: bi.id, to: p.successor.get(bi.id)!.id } }]);
    expect(r.substitutionsRemoved).toEqual(["verl"]);
  });

  it("holdsOn: Wochentag, Zeitraum, A/B-Woche", () => {
    const l = { weekday: 0, week: "A" as const, validFrom: from, validUntil: "2027-03-31" };
    expect(holdsOn(l, "2027-02-01")).toBe(true); // KW 5 = A
    expect(holdsOn(l, "2027-02-08")).toBe(false); // KW 6 = B
    expect(holdsOn(l, "2027-02-02")).toBe(false); // Dienstag
    expect(holdsOn(l, "2027-04-05")).toBe(false); // nach dem Ende
    expect(holdsOn({ ...l, week: "all" }, "2027-01-25")).toBe(false); // vor dem Beginn
  });
});

describe("Änderungsliste (rein)", () => {
  const names = {
    groups: new Map([["g-7b", "7b"]]),
    subjects: new Map([
      ["M", "Mathematik"],
      ["D", "Deutsch"],
    ]),
    teachers: new Map([
      ["u-a", "BRA"],
      ["u-b", "KLE"],
    ]),
  };
  const base = { id: "x", groupId: "g-7b", subjectId: "M", teacherId: "u-a", roomId: "106", weekday: 0, periodNr: 3, week: "all" as const, couplingId: null };
  it("Zeilen für geändert/neu/entfällt; Listen je Lehrkraft (alt und neu) und Klasse; Nachricht mit Zahl", () => {
    const changed = { kind: "changed" as const, before: base, after: { ...base, id: "y", roomId: "105", teacherId: "u-b" }, changes: ["teacher" as const, "room" as const] };
    const added = { kind: "added" as const, before: null, after: { ...base, id: "z", subjectId: "D", weekday: 1, periodNr: 2 }, changes: [] };
    const removed = { kind: "removed" as const, before: { ...base, id: "w", weekday: 4, periodNr: 6, week: "B" as const }, after: null, changes: [] };
    expect(changeLine(changed, names)).toBe("Mo 3. Std Mathematik (7b): Lehrkraft BRA → KLE; Raum 106 → 105");
    expect(changeLine(added, names)).toBe("neu: Di 2. Std Deutsch (7b) · BRA · R 106");
    expect(changeLine(removed, names)).toBe("entfällt: Fr 6. Std (B-Woche) Mathematik (7b)");
    const lists = changeLists([removed, added, changed], names);
    expect(lists.byTeacher.get("u-a")).toEqual([changeLine(changed, names), changeLine(added, names), changeLine(removed, names)]);
    expect(lists.byTeacher.get("u-b")).toEqual([changeLine(changed, names)]);
    expect(lists.byGroup.get("g-7b")).toHaveLength(3);
    const msg = planMessage("Mo., 01.02.", "2.0", lists.byTeacher.get("u-b")!);
    expect(msg.title).toBe("Neuer Stundenplan ab Mo., 01.02.: 1 Änderung für dich");
    expect(msg.body).toContain("Version 2.0.");
    expect(planMessage("Mo., 01.02.", "2.0", Array.from({ length: 15 }, (_, i) => `Zeile ${i}`)).body).toContain("… und 3 weitere");
  });
});
