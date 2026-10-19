// Demo: kleiner Bücherei-Bestand (Jugendbuch, Sachbuch, Film, Spiel) mit Exemplaren, eins davon ausgesondert; einige offene
// Ausleihen (eine überfällig, 2. Mahnung – BU-04), eine Rückgabe mit Befund und anonyme Zähler der letzten Monate (BU-02), eine
// Vormerkung (BU-03), Nutzung je Exemplar und Druckwarteschlange (BU-05).
import { eq, inArray, lte } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiLoans, buechereiReservations, buechereiStats, buechereiTitles } from "@/core/db/schema";
import { addDays, toBerlinDate } from "@/core/time";
import { copyNumber, normalizeIsbn, type MediaType } from "./labels";

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
