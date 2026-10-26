// Schulbücherei – Klassenleitung sieht offene Schulbücher der eigenen Klasse (BU-16): nur Name und Zahlen, Rechte über die
// Klassenleitung, Schalter Schulbuchausleihe, Ausleihen der Bücherei zählen nicht. Querschnitt „keine Titel“: Keine Funktion, die
// Seiten, Theke, Druck (Brief, Ausweise, Etiketten) oder Listen speist, gibt einer Klassenleitung ohne Bücherei-Teamrechte Titel,
// Inventarnummern, Gründe oder Beträge der Schüler:innen heraus; die Seite `/buecherei/klasse` liest nur aus `klasse.ts`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { buechereiCompensations, buechereiCopies, buechereiLoans, buechereiTitles, groupMembers, schoolYears } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { childrenSchoolbooks, issueCopy, issueFindings, issueGroup, issueGroups, issuePerson, issueSummary } from "./ausgabe";
import { cardsToPrint, classMemberIds } from "./cards";
import { dueDate } from "./dates";
import { childrenCompensations, compensationCandidates, compensationLetter, listCompensations } from "./ersatz";
import { labelsToPrint } from "./etiketten";
import { childrenLibrary } from "./katalog";
import { classLeadClasses, classOpenItems, isClassLead } from "./klasse";
import { createMaterial, getMaterial, listMaterials, materialLabels } from "./lernmittel";
import { deskPerson, deskSummary, listFindings, searchBorrowers } from "./loans";
import { dunningList } from "./mahnungen";
import { LERNMITTEL } from "./settings";

const SABINE = "u-sabine.kowalski"; // Verwaltung: alle Bücherei-Rechte, keine Klassenleitung
const AYLIN = "u-aylin.demir"; // Büchereiteam (Theke + Bestand)
const PETRA = "u-petra.lindner"; // Schulleitung
const JANA = "u-jana.brandt"; // Lehrkraft, Klassenleitung 7b
const LEA = "u-lea.schaefer"; // Schülerin 7b
const MUTTER = "u-daniela.schaefer"; // Elternteil von Lea
const MAT = "Geheimes Lesebuch 7 (BU-16)";
const REASON = "Kaffeefleck auf dem Umschlag (BU-16)";

describe("Bücherei – Klassenleitung (BU-16)", () => {
  let h: DbHandle;
  let day: string;
  let numbers: string[];
  let materialId: string;
  let compId: string;
  let libraryTitle: string;
  let otherLead: string;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
    day = await dueDate(h.db, "2026-11-09", 0);
    const [year] = await h.db.select({ endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
    const sabine = await p(SABINE);
    ({ id: materialId, numbers } = await createMaterial(h.db, sabine, { title: MAT, grades: [7], subjectId: "D", provision: "leihe", price: "23,40" }, { count: 2 }));
    await issueCopy(h.db, sabine, LEA, numbers[0]!, day);
    // offene Ersatzforderung (direkt, wie in der Demo) und eine offene Ausleihe der Bücherei (Stufe 1) für Lea
    const [c] = await h.db
      .insert(buechereiCompensations)
      .values({ userId: LEA, item: `${MAT} (${numbers[1]})`, reason: REASON, amountCents: 2340, createdOn: day })
      .returning({ id: buechereiCompensations.id });
    compId = c!.id;
    const loaned = new Set((await h.db.select({ id: buechereiLoans.copyId }).from(buechereiLoans)).map((r) => r.id));
    const copy = (
      await h.db
        .select({ id: buechereiCopies.id, title: buechereiTitles.title })
        .from(buechereiCopies)
        .innerJoin(buechereiTitles, eq(buechereiTitles.id, buechereiCopies.titleId))
        .where(isNull(buechereiCopies.withdrawnOn))
        .orderBy(asc(buechereiCopies.seq))
    ).find((c) => !loaned.has(c.id));
    libraryTitle = copy!.title;
    await h.db.insert(buechereiLoans).values({ copyId: copy!.id, userId: LEA, loanedOn: day, dueOn: year!.endsOn });
    const [lead] = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-5a"), eq(groupMembers.role, "leader")));
    otherLead = lead!.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it("Klassenleitung sieht je Schüler:in Name und Zahlen – Ausleihen der Bücherei zählen nicht", async () => {
    const jana = await p(JANA);
    expect(await isClassLead(h.db, jana)).toBe(true);
    expect((await classLeadClasses(h.db, jana)).map((c) => c.id)).toEqual(["g-7b"]);
    const res = await classOpenItems(h.db, jana);
    expect(res.stage2).toBe(true);
    expect(res.classes).toHaveLength(1);
    const [klasse] = res.classes;
    expect(klasse!.name).toBe("Klasse 7b");
    expect(klasse!.students.length).toBeGreaterThan(20);
    const lea = klasse!.students.find((s) => s.userId === LEA);
    expect(lea).toEqual({ userId: LEA, name: "Lea Schäfer", schoolbooks: 1, compensations: 1 });
    // genau diese Felder – keine Ausleihen, keine Titel
    for (const s of klasse!.students) expect(Object.keys(s).sort()).toEqual(["compensations", "name", "schoolbooks", "userId"]);
    expect(klasse!.students.filter((s) => s.schoolbooks + s.compensations > 0).map((s) => s.userId)).toEqual([LEA]);
  });

  it("Schulbuchausleihe aus → nur Ersatzforderungen", async () => {
    await writeModuleSetting(h.db, LERNMITTEL, "0");
    try {
      const res = await classOpenItems(h.db, await p(JANA));
      expect(res.stage2).toBe(false);
      expect(res.classes[0]!.students.find((s) => s.userId === LEA)).toMatchObject({ schoolbooks: 0, compensations: 1 });
    } finally {
      await writeModuleSetting(h.db, LERNMITTEL, "1");
    }
  });

  it("Rechte: nur die Klassenleitung, nur die eigene Klasse", async () => {
    for (const who of [SABINE, AYLIN, PETRA, LEA, MUTTER]) {
      const v = await p(who);
      expect(await isClassLead(h.db, v)).toBe(false);
      await expect(classOpenItems(h.db, v)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // andere Klassenleitung sieht ihre Klasse, nicht die 7b
    const other = await classOpenItems(h.db, await p(otherLead));
    expect(other.classes.map((c) => c.id)).toContain("g-5a");
    expect(other.classes.map((c) => c.id)).not.toContain("g-7b");
    expect(other.classes.flatMap((c) => c.students).some((s) => s.userId === LEA)).toBe(false);
    // gesperrt bzw. Passwortwechsel offen → nichts
    const jana = await p(JANA);
    await expect(classOpenItems(h.db, { ...jana, locked: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(classOpenItems(h.db, { ...jana, passwordChangePending: true })).rejects.toBeInstanceOf(ForbiddenError);
    // Leitung einer AG/eines Kurses zählt nicht als Klassenleitung
    const noClass: PermissionSet = { ...jana, leaderOf: new Set([...jana.leaderOf].filter((g) => g !== "g-7b")) };
    await expect(classOpenItems(h.db, noClass)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Querschnitt: keine Titel, Inventarnummern, Gründe oder Beträge für die Klassenleitung", async () => {
    const secrets = [MAT, numbers[0]!, numbers[1]!, REASON, "23,40", "2340"];
    const sabine = await p(SABINE);
    // Gegenprobe: die Verwaltung sieht die Einzelheiten tatsächlich
    expect(JSON.stringify(await issuePerson(h.db, sabine, LEA, day))).toContain(MAT);
    expect(JSON.stringify(await listCompensations(h.db, sabine, { open: true }))).toContain(REASON);
    expect(JSON.stringify(await deskPerson(h.db, sabine, LEA, day))).toContain(libraryTitle);

    const jana = await p(JANA);
    const leaks = (value: unknown) => {
      const text = JSON.stringify(value) ?? "";
      return [...secrets, libraryTitle].filter((s) => text.includes(s));
    };
    // die eigene Ansicht
    expect(leaks(await classOpenItems(h.db, jana))).toEqual([]);
    // alle Bücherei-Funktionen mit Personenbezug und Titel (Seiten, Theke, Mahnliste, Druck, Listen)
    const calls: [string, () => Promise<unknown>][] = [
      ["issueGroups", () => issueGroups(h.db, jana)],
      ["issueGroup", () => issueGroup(h.db, jana, "g-7b", day)],
      ["issuePerson", () => issuePerson(h.db, jana, LEA, day)],
      ["issueSummary", () => issueSummary(h.db, jana, day)],
      ["issueFindings", () => issueFindings(h.db, jana)],
      ["childrenSchoolbooks", () => childrenSchoolbooks(h.db, jana, day)],
      ["compensationCandidates", () => compensationCandidates(h.db, jana, day)],
      ["listCompensations offen", () => listCompensations(h.db, jana, { open: true })],
      ["listCompensations zu", () => listCompensations(h.db, jana, { open: false })],
      ["compensationLetter (Druck)", () => compensationLetter(h.db, jana, compId, day)],
      ["childrenCompensations", () => childrenCompensations(h.db, jana)],
      ["childrenLibrary", () => childrenLibrary(h.db, jana, day)],
      ["deskPerson (Theke)", () => deskPerson(h.db, jana, LEA, day)],
      ["deskSummary", () => deskSummary(h.db, jana, day)],
      ["searchBorrowers", () => searchBorrowers(h.db, jana, "Schäfer")],
      ["listFindings", () => listFindings(h.db, jana)],
      ["dunningList (Mahnliste)", () => dunningList(h.db, jana, day)],
      ["cardsToPrint (Druck Ausweise)", () => cardsToPrint(h.db, jana, { groupId: "g-7b" })],
      ["classMemberIds", () => classMemberIds(h.db, jana, "g-7b")],
      ["listMaterials", () => listMaterials(h.db, jana)],
      ["getMaterial", () => getMaterial(h.db, jana, materialId)],
      ["materialLabels (Druck Etiketten)", () => materialLabels(h.db, jana, { materialId })],
      ["labelsToPrint (Druck Etiketten)", () => labelsToPrint(h.db, jana, { kind: "warteschlange" })],
    ];
    for (const [name, call] of calls) {
      const out = await call().then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      if (out.ok) expect(leaks(out.v), name).toEqual([]);
      else expect(out.e instanceof ForbiddenError || out.e instanceof ValidationError, `${name}: ${String(out.e)}`).toBe(true);
    }
  });

  it("Querschnitt: die Seite liest nur aus klasse.ts; keine Bücherei-Seite, kein Druck und keine Route prüft Rechte über die Klassenleitung", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(shell)/buecherei/klasse/page.tsx"), "utf8");
    const imports = [...page.matchAll(/from "(@\/modules\/buecherei\/[^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["@/modules/buecherei/klasse"]);
    // Klassenleitung öffnet sonst nichts: alle anderen Seiten, Drucke und Routen der Bücherei kennen `klasse.ts` höchstens für den Reiter
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(f)) files.push(full);
      }
    };
    walk(join(process.cwd(), "src/app"));
    const users = files.filter((f) => /from "@\/modules\/buecherei\/klasse"/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/").replace(/^.*src\/app\//, ""));
    expect(users.sort()).toEqual(["(shell)/buecherei/klasse/page.tsx", "(shell)/buecherei/page.tsx", "(shell)/buecherei/ui.tsx"]);
    // `leaderOf` taucht im Bücherei-Modul nur in klasse.ts auf (die einzige Freigabe über die Klassenleitung)
    const dir = join(process.cwd(), "src/modules/buecherei");
    const withLeader = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts") && readFileSync(join(dir, f), "utf8").includes("leaderOf"));
    expect(withLeader).toEqual(["klasse.ts"]);
  });
});
