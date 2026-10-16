// Demo-Ressourcen: Fachräume/Bibliothek und typische Geräte.
import type { Db } from "@/core/db/client";
import { bookingResources } from "@/core/db/schema";

export async function seedBuchungen(db: Db) {
  await db.insert(bookingResources).values([
    { kind: "room", roomId: "IF1", name: "Informatik-Raum (IF1)" },
    { kind: "room", roomId: "BIB", name: "Bibliothek (BIB)" },
    { kind: "room", roomId: "015", name: "Raum 015" },
    { kind: "room", roomId: "MU1", name: "Musikraum (MU1)" },
    { kind: "device", name: "Laptopwagen 1", description: "16 Laptops, Ausgabe im Sekretariat" },
    { kind: "device", name: "Laptopwagen 2", description: "16 Laptops, Ausgabe im Sekretariat" },
    { kind: "device", name: "iPad-Koffer", description: "12 iPads" },
    { kind: "device", name: "Beamer (mobil)" },
  ]);
}
