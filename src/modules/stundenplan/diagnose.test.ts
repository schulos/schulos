import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { timetableLessons } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { blocksOf, diagnose, diagnoseYear, gapsOf, type DiagLesson, type DiagnoseInput, type Finding } from "./diagnose";
import { planningYear } from "./verteilung";

describe("gapsOf / blocksOf", () => {
  it("findet Lücken nur zwischen erster und letzter Stunde", () => {
    expect(gapsOf([2, 5, 6], [1, 2, 3, 4, 5, 6, 7])).toEqual([3, 4]);
    expect(gapsOf([1, 2, 3], [1, 2, 3, 4])).toEqual([]);
    expect(gapsOf([], [1, 2])).toEqual([]);
  });
  it("fasst aufeinanderfolgende Stunden zu Blöcken", () => {
    expect(blocksOf([5, 1, 2, 2])).toEqual([[1, 2], [5]]);
  });
});

describe("diagnose", () => {
  let n = 0;
  const lesson = (p: Partial<DiagLesson> & Pick<DiagLesson, "groupId" | "subjectId" | "weekday" | "periodNr">): DiagLesson => ({
    id: `l${++n}`,
    couplingId: null,
    teacherId: null,
    roomId: null,
    week: "all",
    ...p,
  });
  const base = (lessons: DiagLesson[], over: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
    lessons,
    periods: [1, 2, 3, 4, 5, 6, 7],
    groups: [
      { id: "7a", name: "7a", kind: "klasse", gradeLevel: 7, size: 28 },
      { id: "7b", name: "7b", kind: "klasse", gradeLevel: 7, size: 20 },
      { id: "k7", name: "7 WP Bio", kind: "wahlpflicht", gradeLevel: 7, size: 12 },
    ],
    teachers: [{ id: "t1", code: "BRA", name: "Jana Brandt" }],
    subjects: [
      { id: "D", name: "Deutsch", roomKind: null },
      { id: "M", name: "Mathematik", roomKind: null },
      { id: "BI", name: "Biologie", roomKind: "nw" },
    ],
    rooms: [
      { id: "101", kind: "klassenraum", capacity: 30, active: true },
      { id: "102", kind: "klassenraum", capacity: 24, active: true },
      { id: "NW1", kind: "nw", capacity: 30, active: true },
      { id: "ALT", kind: "klassenraum", capacity: null, active: false },
    ],
    distribution: { assignments: [], unmatched: [], curriculum: new Map() },
    accounts: [],
    ...over,
  });
  const messages = (fs: Finding[], cat: Finding["category"]) => fs.filter((f) => f.category === cat).map((f) => `${f.target.label}: ${f.message}`);

  it("Hohlstunden je Lehrkraft und Klasse, Kursband des Jahrgangs zählt als belegt, A/B getrennt", () => {
    const fs = diagnose(
      base([
        lesson({ groupId: "7a", subjectId: "D", teacherId: "t1", weekday: 0, periodNr: 1 }),
        lesson({ groupId: "7a", subjectId: "M", weekday: 0, periodNr: 4 }),
        lesson({ groupId: "7b", subjectId: "D", teacherId: "t1", weekday: 0, periodNr: 3 }),
        // Klasse 7b: 3. Stunde, WP-Band 4., dann 5. → keine Lücke; 7. nur in A-Woche → Lücke 6. in A
        lesson({ groupId: "k7", subjectId: "BI", weekday: 0, periodNr: 4 }),
        lesson({ groupId: "7b", subjectId: "M", weekday: 0, periodNr: 5 }),
        lesson({ groupId: "7b", subjectId: "M", weekday: 0, periodNr: 7, week: "A" }),
      ]),
    );
    // Klassen (warn) vor Lehrkräften (info)
    expect(messages(fs, "gaps")).toEqual(["7a: Mo: 2 Hohlstunden (2., 3.)", "7b: Mo (A-Woche): 1 Hohlstunde (6.)", "BRA: Mo: 1 Hohlstunde (2.)"]);
    expect(fs.find((f) => f.target.label === "BRA")!.severity).toBe("info");
  });

  it("Fach mehrfach am Tag: getrennt oder mehr als eine Doppelstunde; Doppelstunde ist in Ordnung", () => {
    const fs = diagnose(
      base([
        lesson({ groupId: "7a", subjectId: "D", weekday: 1, periodNr: 1 }),
        lesson({ groupId: "7a", subjectId: "D", weekday: 1, periodNr: 2 }),
        lesson({ groupId: "7a", subjectId: "M", weekday: 1, periodNr: 3 }),
        lesson({ groupId: "7a", subjectId: "M", weekday: 1, periodNr: 5 }),
        lesson({ groupId: "7b", subjectId: "D", weekday: 2, periodNr: 1 }),
        lesson({ groupId: "7b", subjectId: "D", weekday: 2, periodNr: 2 }),
        lesson({ groupId: "7b", subjectId: "D", weekday: 2, periodNr: 3 }),
      ]),
    );
    expect(messages(fs, "subjectDay")).toEqual(["7a: Mathematik am Di 2× getrennt (3., 5.)", "7b: Deutsch am Mi 3 Stunden am Stück (1., 2., 3.)"]);
  });

  it("Doppelstunde über die große Pause (SP-G-04a): nur als Hinweis, nur wenn der Lehrauftrag Doppelstunden vorsieht", () => {
    const lessons = [
      lesson({ groupId: "7a", subjectId: "D", weekday: 1, periodNr: 2 }),
      lesson({ groupId: "7a", subjectId: "D", weekday: 1, periodNr: 3 }),
      lesson({ groupId: "7a", subjectId: "M", weekday: 1, periodNr: 4 }),
      lesson({ groupId: "7a", subjectId: "M", weekday: 1, periodNr: 5 }),
    ];
    const assignment = (subjectId: string, doubleLessons: number) => ({
      id: `a-${subjectId}`,
      subjectId,
      subjectName: subjectId,
      color: "#000",
      hours: 2,
      doubleLessons,
      roomId: null,
      note: null,
      groups: [{ id: "7a", name: "7a" }],
      teachers: [],
      planned: 2,
      otherTeacher: false,
      bandId: null,
    });
    const dist = { assignments: [assignment("D", 1), assignment("M", 0)], unmatched: [], curriculum: new Map() };
    // ohne Pausenangabe nichts; mit Pause nach der 2. und 4.: Deutsch (Doppelstunde gewünscht) → Hinweis, Mathe (keine) → nichts
    expect(messages(diagnose(base(lessons, { distribution: dist })), "subjectDay")).toEqual([]);
    const fs = diagnose(base(lessons, { distribution: dist, breakAfter: [2, 4] }));
    expect(fs.filter((f) => f.category === "subjectDay").map((f) => [f.severity, f.message])).toEqual([["info", "Deutsch am Di: Doppelstunde über die große Pause (2., 3.)"]]);
  });

  it("Räume: falsche Art, inaktiv, zu klein (Kopplung im selben Raum zählt zusammen), ohne Raum – je Fach zusammengefasst", () => {
    const fs = diagnose(
      base([
        lesson({ groupId: "7a", subjectId: "BI", roomId: "101", weekday: 0, periodNr: 1 }),
        lesson({ groupId: "7a", subjectId: "BI", roomId: "101", weekday: 3, periodNr: 2 }),
        lesson({ groupId: "7a", subjectId: "D", roomId: "ALT", weekday: 0, periodNr: 2 }),
        lesson({ groupId: "7b", subjectId: "D", roomId: "102", weekday: 0, periodNr: 1 }),
        lesson({ groupId: "7a", subjectId: "M", roomId: "101", couplingId: "c1", weekday: 1, periodNr: 1 }),
        lesson({ groupId: "7b", subjectId: "M", roomId: "101", couplingId: "c1", weekday: 1, periodNr: 1 }),
        lesson({ groupId: "7b", subjectId: "BI", weekday: 2, periodNr: 1 }),
      ]),
    );
    const rooms = fs.filter((f) => f.category === "room");
    expect(rooms.map((f) => [f.severity, `${f.target.label}: ${f.message}`])).toEqual([
      ["error", "7a: Deutsch in Raum ALT: Raum ist inaktiv – Mo 2."],
      ["warn", "7a: Biologie in Raum 101 (Klassenraum), Wunsch: Naturwissenschaften – Mo 1., Do 2."],
      ["warn", "7a: Mathematik in Raum 101: 48 Personen, Kapazität 30 – Di 1."],
      ["warn", "7b: Mathematik in Raum 101: 48 Personen, Kapazität 30 – Di 1."],
      ["warn", "7b: Biologie ohne Raum (Wunsch: Naturwissenschaften) – Mi 1."],
    ]);
  });

  it("Bänder (SP2-02): nicht zur selben Zeit, gemeinsame Schüler:innen in zwei Mitgliedern (Q-SP2-6), leeres Band", () => {
    const assignment = (id: string, groupId: string, subjectId: string) => ({
      id,
      subjectId,
      subjectName: subjectId,
      color: "#000",
      hours: 2,
      doubleLessons: 0,
      roomId: null,
      note: null,
      bandId: "b1",
      groups: [{ id: groupId, name: groupId }],
      teachers: [],
      planned: 2,
      otherTeacher: false,
    });
    const band = (id: string, name: string, memberIds: string[], planned: number, together: number) => ({ id, name, hours: 2, doubleLessons: 0, memberIds, planned, together, uniform: false });
    const fs = diagnose(
      base([], {
        distribution: {
          assignments: [assignment("a", "7a", "D"), assignment("b", "7b", "M"), assignment("c", "k7", "BI")],
          unmatched: [],
          curriculum: new Map(),
          bands: [band("b1", "Schiene 7", ["a", "b", "c"], 2, 1), band("b2", "leer", [], 0, 0), band("b3", "einzeln", ["a"], 2, 2)],
        },
        conflicts: new Map([
          ["7b", new Set(["k7"])],
          ["k7", new Set(["7b"])],
        ]),
      }),
    );
    expect(messages(fs, "band")).toEqual([
      "Schiene 7: nur 1 Stunde von 2 Stunden zur selben Zeit – die Lehraufträge des Bands liegen teils in verschiedenen Slots",
      "Schiene 7: 7b und 7 WP Bio haben gemeinsame Schüler:innen – im Band liegen sie zur selben Zeit, diese Schüler:innen können nur einen Kurs besuchen",
      "leer: Band ohne Lehraufträge",
    ]);
    expect(fs.filter((f) => f.category === "band").map((f) => [f.target.kind, f.target.id, f.severity])).toEqual([
      ["band", "b1", "warn"],
      ["band", "b1", "warn"],
      ["band", "b2", "info"],
    ]);
    // Band vollständig gemeinsam, keine gemeinsamen Schüler:innen → nichts
    expect(messages(diagnose(base([], { distribution: { assignments: [assignment("a", "7a", "D"), assignment("b", "7b", "M")], unmatched: [], curriculum: new Map(), bands: [band("b1", "ok", ["a", "b"], 2, 2)] } })), "band")).toEqual([]);
  });

  it("offene Stunden, Stundentafel und Deputat", () => {
    const a = (id: string, subjectId: string, subjectName: string, hours: number, planned: number, teachers = [{ id: "t1", code: "BRA", name: "Jana Brandt" }]) => ({
      id,
      subjectId,
      subjectName,
      color: "#000",
      hours,
      doubleLessons: 0,
      roomId: null,
      note: null,
      groups: [{ id: "7a", name: "7a" }],
      teachers,
      planned,
      otherTeacher: false,
      bandId: null,
    });
    const fs = diagnose(
      base([], {
        distribution: {
          assignments: [a("a1", "D", "Deutsch", 4, 2), a("a2", "M", "Mathematik", 4, 5), a("a3", "BI", "Biologie", 2, 2, [])],
          unmatched: [
            { id: "x", groupId: "7b", subjectId: "M", teacherId: "t1", weight: 1, groupName: "7b", subjectName: "Mathematik", teacherCode: "BRA" },
            { id: "y", groupId: "7b", subjectId: "M", teacherId: "t1", weight: 0.5, groupName: "7b", subjectName: "Mathematik", teacherCode: "BRA" },
          ],
          curriculum: new Map([[7, new Map([["D", 4], ["M", 4], ["E", 4]])]]),
        },
        accounts: [
          { id: "t1", code: "BRA", name: "Jana Brandt", target: 24.5, assigned: 20, balance: -4.5 },
          { id: "t2", code: "LIN", name: "Petra Lindner", target: 15.5, assigned: 15.5, balance: 0 },
          { id: "t3", code: "WAG", name: "Sophie Wagner", target: 14, assigned: 16, balance: 2 },
        ],
      }),
    );
    expect(fs.filter((f) => f.category === "open").map((f) => [f.severity, f.message])).toEqual([
      ["error", "Mathematik (BRA): 1 Stunde mehr verplant als beauftragt"],
      ["warn", "Deutsch (BRA): 2 Stunden nicht verplant"],
      ["warn", "Mathematik (BRA): 1,5 Stunden im Plan ohne Lehrauftrag"],
      ["info", "Biologie: Lehrauftrag ohne Lehrkraft"],
    ]);
    expect(fs.find((f) => f.message.startsWith("Deutsch (BRA)"))!.assignmentId).toBe("a1");
    expect(messages(fs, "curriculum")).toEqual([
      "7a: E: Stundentafel 4, Lehraufträge 0 – 4 Stunden fehlen",
      "7b: noch keine Lehraufträge (Stundentafel 12 Stunden)",
      "7a: Biologie: Stundentafel 0, Lehraufträge 2 – 2 Stunden mehr",
    ]);
    expect(messages(fs, "deputy")).toEqual(["BRA: 4,5 Stunden unter Soll (Soll 24,5, Lehraufträge 20)", "WAG: 2 Stunden über Soll (Soll 14, Lehraufträge 16)"]);
  });
});

describe("diagnoseYear (Demo-Schule)", () => {
  let h: DbHandle;
  const today = "2026-10-05";
  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(() => h.close());

  it("Demo-Plan: keine offenen Stunden, kaum Hohlstunden in Klassen, Fächer nur als Doppelstunde, Stundentafel erfüllt", async () => {
    const year = (await planningYear(h.db))!;
    const r = await diagnoseYear(h.db, year, today, 25.5);
    // der Greedy-Seed lässt vereinzelt Lücken in Klassen (der Solver in P2b-24 räumt sie auf)
    const classGaps = r.findings.filter((f) => f.category === "gaps" && f.target.kind === "group");
    expect(classGaps.length).toBeLessThan(5);
    expect(classGaps.every((f) => /^(Mo|Di|Mi|Do|Fr): 1 Hohlstunde/.test(f.message))).toBe(true);
    expect(r.counts.open).toEqual({ error: 0, warn: 0, info: 0 });
    expect(r.counts.subjectDay.warn).toBe(0);
    expect(r.counts.curriculum.warn).toBe(0);
    expect(r.counts.room.error).toBe(0);
    // Deputat: Demo-Lehrkräfte sind nicht voll ausgeplant
    expect(r.counts.deputy.warn).toBeGreaterThan(0);
    // SP2-02: das Demo-Band liegt vollständig gemeinsam, seine Kurse haben getrennte Schüler:innen
    expect(r.counts.band).toEqual({ error: 0, warn: 0, info: 0 });

    // eine Biologie-Stunde der 7b im Klassenraum und zusätzlich am selben Tag getrennt → Raum + Fach mehrfach
    const bio = (await h.db.select().from(timetableLessons)).find((l) => l.groupId === "g-7b" && l.subjectId === "BI")!;
    const taken = new Set((await h.db.select().from(timetableLessons)).filter((l) => l.groupId === "g-7b" && l.weekday === bio.weekday).map((l) => l.periodNr));
    const free = [1, 2, 3, 4, 5, 6, 7, 8].find((p) => !taken.has(p) && Math.abs(p - bio.periodNr) > 1)!;
    await h.db.insert(timetableLessons).values({ groupId: "g-7b", weekday: bio.weekday, periodNr: free, subjectId: "BI", roomId: "102", validFrom: year.startsOn, validUntil: year.endsOn });
    const r2 = await diagnoseYear(h.db, year, today, 25.5);
    const of7b = r2.findings.filter((f) => f.target.id === "g-7b");
    expect(of7b.some((f) => f.category === "subjectDay" && f.message.startsWith("Biologie"))).toBe(true);
    expect(of7b.some((f) => f.category === "room" && f.message.includes("Raum 102 (Klassenraum), Wunsch: Naturwissenschaften"))).toBe(true);
    expect(of7b.some((f) => f.category === "open" && f.message.includes("mehr verplant als beauftragt"))).toBe(true);
  });
});
