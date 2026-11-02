// Gebäude & Technik (INV-05, Art. 15 DSGVO): lesbarer Teil der Auskunft – eigene Leihgeräte mit Gerät, Inventarnummer und Fristen
// statt Kennungen. Die Rohdaten (`gebaeude_loans`) kommen ohnehin über den Verweis auf das Konto in die Auskunft.
import type { Db } from "@/core/db/client";
import type { ReadableExport } from "../auskunft";
import { loanAuskunft } from "./leihe";

export const gebaeudeAuskunft: ReadableExport = {
  moduleId: "gebaeude",
  async build(db: Db, userId: string) {
    const loans = await loanAuskunft(db, userId);
    return [
      {
        table: "leihgeraete",
        purpose: "Leihgeräte der Schule: offene Ausleihen und zurückgegebene bis zum Ablauf der Löschfrist (1 Jahr nach Rückgabe)",
        categories: ["Gerät", "Inventarnummer", "Kategorie", "ausgeliehen", "Rückgabe bis", "zurückgegeben", "Zubehör", "Befund", "Erinnerungen nach Fristende"],
        rows: loans,
      },
    ].filter((s) => s.rows.length > 0);
  },
};
