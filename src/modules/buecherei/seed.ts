// Demo: kleiner Bücherei-Bestand (Jugendbuch, Sachbuch, Film, Spiel) mit Exemplaren, eins davon ausgesondert.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiCopies, buechereiTitles } from "@/core/db/schema";
import { toBerlinDate } from "@/core/time";
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

export async function seedBuecherei(db: Db, now = new Date()) {
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
}
