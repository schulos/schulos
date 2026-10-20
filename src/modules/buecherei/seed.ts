// Demo: kleiner Bücherei-Bestand (Jugendbuch, Sachbuch, Film, Spiel) mit Exemplaren, eins davon ausgesondert; einige offene
// Ausleihen (eine überfällig, 2. Mahnung – BU-04), eine Rückgabe mit Befund und anonyme Zähler der letzten Monate (BU-02), eine
// Vormerkung (BU-03), Nutzung je Exemplar und Druckwarteschlange (BU-05).
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import {
  buechereiBooklists,
  buechereiCopies,
  buechereiLoans,
  buechereiMaterialCopies,
  buechereiMaterialIssues,
  buechereiReservations,
  buechereiStats,
  buechereiTeachingMaterials,
  buechereiTitles,
  groupMembers,
  schoolYears,
  users,
} from "@/core/db/schema";
import { writeModuleSetting } from "@/core/modules/settings";
import { addDays, toBerlinDate } from "@/core/time";
import { copyNumber, materialNumber, normalizeIsbn, type MaterialProvision, type MediaType } from "./labels";
import { LERNMITTEL } from "./settings";

interface DemoTitle {
  title: string;
  author?: string;
  isbn?: string;
  publisher?: string;
  year?: number;
  keywords?: string;
  ageFrom?: number;
  mediaType?: MediaType;
  signature: string;
  location: string;
  copies: number;
}

// Erfundene Titel und Verlage (keine echten Werke); ISBNs mit gültiger Prüfziffer, aber ohne Bezug zu echten Büchern.
const TITLES: DemoTitle[] = [
  { title: "Die Nacht im Leuchtturm", author: "Mara Feld", isbn: "978-3-00-000001-0", publisher: "Lindenblatt", year: 2019, keywords: "Abenteuer, Freundschaft", ageFrom: 11, signature: "JB FEL", location: "Regal 2, Jugendbuch", copies: 3 },
  { title: "Wolkenfänger", author: "Jonas Brink", isbn: "978-3-00-000002-7", publisher: "Lindenblatt", year: 2021, keywords: "Fantasy", ageFrom: 12, signature: "JB BRI", location: "Regal 2, Jugendbuch", copies: 2 },
  { title: "Das Geheimnis der Schulglocke", author: "Ida Sommer", isbn: "978-3-00-000003-4", publisher: "Kleiner Hafen", year: 2018, keywords: "Krimi, Schule", ageFrom: 10, signature: "KJ SOM", location: "Regal 1, Kinderbuch", copies: 2 },
  { title: "Vulkane und Erdbeben", author: "Paul Gerber", isbn: "978-3-00-000004-1", publisher: "Wissenswerk", year: 2020, keywords: "Erdkunde, Geologie", ageFrom: 10, signature: "SB GEO", location: "Regal 5, Sachbuch", copies: 1 },
  { title: "Programmieren für Einsteiger", author: "Lena Kurz", isbn: "978-3-00-000005-8", publisher: "Wissenswerk", year: 2023, keywords: "Informatik", ageFrom: 12, signature: "SB INF", location: "Regal 5, Sachbuch", copies: 2 },
  { title: "Atlas der Welt", publisher: "Wissenswerk", year: 2022, keywords: "Erdkunde, Karten", signature: "NS ATL", location: "Nachschlagewerke", copies: 1 },
  { title: "Reise zum Mond (Dokumentation)", year: 2017, keywords: "Raumfahrt, Physik", mediaType: "film", signature: "F RAU", location: "Medienschrank", copies: 1 },
  { title: "Brückenbauer (Brettspiel)", year: 2020, keywords: "Strategie, 2–4 Personen", mediaType: "spiel", ageFrom: 8, signature: "SP BRU", location: "Spieleregal", copies: 1 },
];

export async function seedBuecherei(db: Db, opts: { now?: Date; borrowers?: readonly string[] } = {}) {
  const now = opts.now ?? new Date();
  let seq = 0;
  for (const t of TITLES) {
    const [row] = await db
      .insert(buechereiTitles)
      .values({
        title: t.title,
        author: t.author ?? null,
        isbn: t.isbn ? normalizeIsbn(t.isbn) : null,
        publisher: t.publisher ?? null,
        year: t.year ?? null,
        keywords: t.keywords ?? null,
        ageFrom: t.ageFrom ?? null,
        mediaType: t.mediaType ?? "buch",
      })
      .returning({ id: buechereiTitles.id });
    for (let i = 0; i < t.copies; i++) {
      seq++;
      await db.insert(buechereiCopies).values({ titleId: row!.id, seq, barcode: copyNumber(seq), signature: t.signature, location: t.location, condition: i === 0 ? "gebraucht" : "gut" });
    }
  }
  // ein ausgesondertes Exemplar (beschädigt)
  await db.update(buechereiCopies).set({ withdrawnOn: toBerlinDate(now), withdrawnReason: "Wasserschaden" }).where(eq(buechereiCopies.seq, 2));

  // BU-05: Nutzung je Exemplar (ohne Person) und Etiketten – zwei Exemplare stehen noch in der Druckwarteschlange; ein
  // Exemplar lange nicht ausgeliehen, eins in schlechtem Zustand, der Atlas seit Jahren nie ausgeliehen (Aussonderungsvorschläge)
  const ym = (back: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const usage: Record<number, { loanCount: number; lastLoanMonth: string | null; condition?: "schlecht"; createdAt?: Date }> = {
    1: { loanCount: 6, lastLoanMonth: ym(0) },
    3: { loanCount: 4, lastLoanMonth: ym(50) },
    4: { loanCount: 3, lastLoanMonth: ym(0) },
    5: { loanCount: 2, lastLoanMonth: ym(1) },
    6: { loanCount: 5, lastLoanMonth: ym(2) },
    7: { loanCount: 5, lastLoanMonth: ym(1) },
    8: { loanCount: 2, lastLoanMonth: ym(6), condition: "schlecht" },
    9: { loanCount: 1, lastLoanMonth: ym(1) },
    10: { loanCount: 1, lastLoanMonth: ym(3) },
    11: { loanCount: 0, lastLoanMonth: null, createdAt: new Date(Date.UTC(now.getUTCFullYear() - 5, 0, 15)) },
    12: { loanCount: 2, lastLoanMonth: ym(1) },
  };
  for (const [s, u] of Object.entries(usage)) await db.update(buechereiCopies).set(u).where(eq(buechereiCopies.seq, Number(s)));
  await db.update(buechereiCopies).set({ labelPrintedAt: now }).where(lte(buechereiCopies.seq, 11));

  // BU-02: Ausleihen der Demo-Schüler:innen (nie die feste Demo-Schülerin – die E2E-Tests leihen selbst aus)
  const [a, b, c] = opts.borrowers ?? [];
  if (!a || !b || !c) return;
  const today = toBerlinDate(now);
  const copies = new Map(
    (await db.select({ id: buechereiCopies.id, seq: buechereiCopies.seq }).from(buechereiCopies).where(inArray(buechereiCopies.seq, [1, 4, 9, 12]))).map((r) => [r.seq, r.id]),
  );
  await db.insert(buechereiLoans).values([
    { copyId: copies.get(1)!, userId: a, loanedOn: addDays(today, -20), dueOn: addDays(today, 8) },
    // BU-04: überfällig, schon zweimal gemahnt
    { copyId: copies.get(12)!, userId: a, loanedOn: addDays(today, -30), dueOn: addDays(today, -16), dunningLevel: 2, dunnedOn: addDays(today, -2) },
    { copyId: copies.get(4)!, userId: b, loanedOn: addDays(today, -3), dueOn: addDays(today, 25), renewals: 0 },
    { copyId: copies.get(9)!, userId: c, loanedOn: addDays(today, -35), dueOn: addDays(today, -7), returnedOn: addDays(today, -2), finding: "Seiten eingerissen" },
  ]);
  // BU-03: der Film (einziges Exemplar, überfällig) ist vorgemerkt
  const [film] = await db.select({ titleId: buechereiCopies.titleId }).from(buechereiCopies).where(eq(buechereiCopies.seq, 12));
  await db.insert(buechereiReservations).values({ titleId: film!.titleId, userId: b });
  const month = (back: number) => {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - back, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  await db.insert(buechereiStats).values([
    { month: month(2), mediaType: "buch", loans: 23, renewals: 4 },
    { month: month(2), mediaType: "film", loans: 3 },
    { month: month(1), mediaType: "buch", loans: 31, renewals: 6 },
    { month: month(1), mediaType: "spiel", loans: 2 },
    { month: month(0), mediaType: "buch", loans: 9, renewals: 1 },
    { month: month(0), mediaType: "film", loans: 1, dunnings: 2 },
  ]);
}

// BU-10: Schulbuchausleihe in der Demo eingeschaltet – erfundene Lernmittel (keine echten Werke, ISBN ohne Bezug zu echten
// Büchern) für die Jahrgänge 5–7, Exemplare mit Inventarnummer, Bücherliste 5 freigegeben, 6 als Entwurf. Ohne Personenbezug.
const MATERIALS: { title: string; publisher: string; isbn?: string; subjectId: string; grades: number[]; course?: string; provision: MaterialProvision; priceCents?: number; copies?: number }[] = [
  { title: "Wortwerkstatt Deutsch 5", publisher: "Lindenblatt", isbn: "978-3-00-000011-9", subjectId: "D", grades: [5], provision: "leihe", priceCents: 2650, copies: 6 },
  { title: "Zahlenwege 5", publisher: "Wissenswerk", isbn: "978-3-00-000012-6", subjectId: "M", grades: [5], provision: "leihe", priceCents: 2890, copies: 6 },
  { title: "Zahlenwege 5 – Arbeitsheft", publisher: "Wissenswerk", subjectId: "M", grades: [5], provision: "kauf", priceCents: 1095 },
  { title: "Green Paths 1", publisher: "Kleiner Hafen", isbn: "978-3-00-000013-3", subjectId: "E", grades: [5], provision: "leihe", priceCents: 2775, copies: 4 },
  { title: "Schulatlas Lindenhof", publisher: "Wissenswerk", isbn: "978-3-00-000014-0", subjectId: "EK", grades: [5, 6, 7, 8, 9, 10], provision: "leihe", priceCents: 3450, copies: 8 },
  { title: "Zahlenwege 6", publisher: "Wissenswerk", isbn: "978-3-00-000015-7", subjectId: "M", grades: [6], provision: "leihe", priceCents: 2890, copies: 3 },
  { title: "Zahlenwege 7 (E-Kurs)", publisher: "Wissenswerk", isbn: "978-3-00-000016-4", subjectId: "M", grades: [7], course: "E-Kurs", provision: "leihe", priceCents: 2990, copies: 2 },
];

export async function seedLernmittel(db: Db, opts: { now?: Date } = {}) {
  await writeModuleSetting(db, LERNMITTEL, "1");
  let seq = 0;
  for (const m of MATERIALS) {
    const [row] = await db
      .insert(buechereiTeachingMaterials)
      .values({ title: m.title, publisher: m.publisher, isbn: m.isbn ? normalizeIsbn(m.isbn) : null, subjectId: m.subjectId, grades: m.grades, course: m.course ?? null, provision: m.provision, priceCents: m.priceCents ?? null })
      .returning({ id: buechereiTeachingMaterials.id });
    for (let i = 0; i < (m.copies ?? 0); i++) {
      seq++;
      await db.insert(buechereiMaterialCopies).values({
        materialId: row!.id,
        seq,
        inventoryNumber: materialNumber(seq),
        condition: i === 0 ? "gebraucht" : i === 1 && m.grades.length > 1 ? "schlecht" : "gut",
        conditionNote: i === 1 && m.grades.length > 1 ? "Einband lose" : null,
        acquiredYear: 2024,
      });
    }
  }
  await db.insert(buechereiBooklists).values([
    { gradeLevel: 5, text: "Die ausgeliehenen Bücher bitte mit einem Schutzumschlag versehen und am Schuljahresende vollständig zurückgeben.\nArbeitshefte kaufen Sie bitte selbst bis zum ersten Schultag.", published: true },
    { gradeLevel: 6, text: "", published: false },
  ]);
  await seedSchulbuchAusgabe(db, opts.now ?? new Date());
}

/**
 * BU-11: Ausgabe in der Demo – die ersten Schüler:innen der 5a haben ihre Schulbücher des Schuljahres (Deutsch, Mathe, Englisch,
 * Atlas), eine fehlt noch ein Buch, eine Rücknahme mit Befund (Grundlage der Ersatzforderung, BU-12). Die feste Demo-Schülerin
 * (7b) bleibt frei – die E2E-Tests geben selbst aus.
 */
async function seedSchulbuchAusgabe(db: Db, now: Date) {
  const [year] = await db.select({ id: schoolYears.id, endsOn: schoolYears.endsOn }).from(schoolYears).where(eq(schoolYears.isCurrent, true));
  if (!year) return;
  const students = (
    await db
      .select({ id: users.id })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.userId))
      .where(and(eq(groupMembers.groupId, "g-5a"), eq(groupMembers.role, "member"), eq(users.role, "schueler")))
      .orderBy(asc(users.id))
  ).map((r) => r.id);
  if (students.length < 4) return;
  const copiesOf = async (title: string) =>
    (
      await db
        .select({ id: buechereiMaterialCopies.id })
        .from(buechereiMaterialCopies)
        .innerJoin(buechereiTeachingMaterials, eq(buechereiTeachingMaterials.id, buechereiMaterialCopies.materialId))
        .where(eq(buechereiTeachingMaterials.title, title))
        .orderBy(asc(buechereiMaterialCopies.seq))
    ).map((r) => r.id);
  const [deutsch, mathe, englisch, atlas] = await Promise.all(["Wortwerkstatt Deutsch 5", "Zahlenwege 5", "Green Paths 1", "Schulatlas Lindenhof"].map(copiesOf));
  const issuedOn = addDays(toBerlinDate(now), -45);
  const base = { schoolYearId: year.id, issuedOn, dueOn: year.endsOn };
  const rows: (typeof buechereiMaterialIssues.$inferInsert)[] = [];
  for (let i = 0; i < 3; i++) {
    rows.push({ ...base, copyId: deutsch![i + 1]!, userId: students[i]! }, { ...base, copyId: mathe![i + 1]!, userId: students[i]! }, { ...base, copyId: atlas![i + 2]!, userId: students[i]! });
    // die dritte Schülerin hat ihr Englischbuch noch nicht („fehlt noch“)
    if (i < 2) rows.push({ ...base, copyId: englisch![i + 1]!, userId: students[i]! });
  }
  // Rücknahme mit Befund (vorzeitig zurück, Wasserschaden) – bleibt bis zur Erledigung
  rows.push({ ...base, copyId: mathe![4]!, userId: students[3]!, returnedOn: addDays(toBerlinDate(now), -5), finding: "Wasserschaden, Seiten gewellt" });
  await db.insert(buechereiMaterialIssues).values(rows);
}
