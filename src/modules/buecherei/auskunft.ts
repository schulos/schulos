// Schulbücherei (BU-03, Art. 15 DSGVO): lesbarer Teil der Auskunft – offene Ausleihen, Rückgaben mit Befund und Vormerkungen mit
// Titel statt Kennungen; BU-11: Schulbücher (offen bzw. mit Befund). Einen Ausleihverlauf gibt es nicht (Rückgabe ohne Befund löscht die Ausleihe), also auch keinen hier.
import type { Db } from "@/core/db/client";
import type { ReadableExport } from "../auskunft";
import { schoolbookAuskunft } from "./ausgabe";
import { libraryAuskunft } from "./katalog";

export const buechereiAuskunft: ReadableExport = {
  moduleId: "buecherei",
  async build(db: Db, userId: string) {
    const [{ loans, reservations }, schoolbooks] = await Promise.all([libraryAuskunft(db, userId), schoolbookAuskunft(db, userId)]);
    return [
      {
        table: "ausleihen",
        purpose: "Schulbücherei: offene Ausleihen und Rückgaben mit Befund (ein Verlauf wird nicht gespeichert)",
        categories: ["Titel", "Exemplar", "ausgeliehen", "fällig", "Verlängerungen", "Mahnstufe", "Rückgabe mit Befund"],
        rows: loans,
      },
      {
        table: "vormerkungen",
        purpose: "Schulbücherei: Vormerkungen",
        categories: ["Titel", "vorgemerkt am", "bereit seit / Abholfrist"],
        rows: reservations,
      },
      {
        table: "schulbuecher",
        purpose: "Schulbuchausleihe: offene Schulbücher (nur das Schuljahr der Ausgabe) und Rücknahmen mit Befund – zurückgegebene werden nicht gespeichert",
        categories: ["Titel", "Inventarnummer", "Schuljahr", "ausgegeben", "zurück bis", "Mahnstufe", "Rücknahme mit Befund"],
        rows: schoolbooks,
      },
    ].filter((s) => s.rows.length > 0);
  },
};
