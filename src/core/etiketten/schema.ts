// RS-11/INV-02: Codes für Kurz-URLs auf gedruckten Etiketten – nur relative Imports (drizzle-kit). Liegt hier statt in
// schema-core, weil die Ziele aus Kern (Räume) und Modul (Inventar) kommen.
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gebaeudeAssets } from "../../modules/gebaeude/schema";
import { rooms } from "../db/schema-core";

/**
 * RS-11: Codes für Kurz-URLs auf gedruckten Etiketten (Tür-QR `/r/<code>`, Inventar-Etikett `/i/<code>`; gemeinsamer Unterbau).
 * Je Ziel genau ein gültiger Code; Neuerzeugen ersetzt die Zeile, der alte Code ist sofort ungültig. Das Ziel steht in einer
 * typisierten Spalte je Art (Fremdschlüssel mit Kaskade – Umbenennen und Löschen des Ziels ziehen mit); eine neue Art bekommt
 * eine eigene Spalte und erweitert die Prüfungen. Keine Personen.
 */
export const labelCodes = pgTable(
  "label_codes",
  {
    /** 16 Zeichen aus 32 (80 Bit Zufall), `src/core/etiketten/codes.ts` */
    code: text("code").primaryKey(),
    /** Art des Ziels (`LABEL_KINDS`): „raum“ oder „inventar“ */
    kind: text("kind").notNull(),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    /** INV-02: Inventargut (Modul `gebaeude`) */
    assetId: text("asset_id").references(() => gebaeudeAssets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("label_codes_kind", sql`${t.kind} in ('raum', 'inventar')`),
    check("label_codes_target", sql`((${t.kind} = 'raum') = (${t.roomId} is not null)) and ((${t.kind} = 'inventar') = (${t.assetId} is not null))`),
    uniqueIndex("label_codes_room_uq").on(t.roomId),
    uniqueIndex("label_codes_asset_uq").on(t.assetId),
  ],
);
