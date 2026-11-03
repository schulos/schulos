// Gebäude & Technik (P4-11) – nur relative Imports (drizzle-kit).
import { sql } from "drizzle-orm";
import { type AnyPgColumn, boolean, date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { buildingFloors, buildings, groups, rooms } from "../../core/db/schema-core";
import { calendarEvents } from "../kalender/schema";
import { timetableRoomBlocks } from "../stundenplan/schema";
import {
  ASSET_CONDITIONS,
  INSPECTION_RESPONSIBLES,
  INSPECTION_RESULTS,
  INSPECTION_TARGETS,
  INVENTORY_ITEM_STATES,
  INVENTORY_METHODS,
  TICKET_CATEGORIES,
  TICKET_EVENT_KINDS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from "./labels";

export const gebaeudeCategoryEnum = pgEnum("gebaeude_category", TICKET_CATEGORIES);
export const gebaeudePriorityEnum = pgEnum("gebaeude_priority", TICKET_PRIORITIES);
export const gebaeudeStatusEnum = pgEnum("gebaeude_status", TICKET_STATUSES);
export const gebaeudeEventKindEnum = pgEnum("gebaeude_event_kind", TICKET_EVENT_KINDS);

/** Meldung (Mangel/Störung). Nummer „M-<year>-<seq>“ läuft je Kalenderjahr. */
export const gebaeudeTickets = pgTable(
  "gebaeude_tickets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    year: integer("year").notNull(),
    seq: integer("seq").notNull(),
    category: gebaeudeCategoryEnum("category").notNull(),
    priority: gebaeudePriorityEnum("priority").notNull().default("normal"),
    status: gebaeudeStatusEnum("status").notNull().default("neu"),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Ort ohne Raum, z. B. „Pausenhof, Westseite“ */
    location: text("location"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Raumsperre aus dem Ticket (P4-14) */
    roomBlockId: text("room_block_id").references(() => timetableRoomBlocks.id, { onDelete: "set null" }),
    /** INV-03: betroffenes Inventargut (Mangel über das Etikett gemeldet bzw. aus einer Prüfung); Löschen des Guts lässt die Meldung stehen */
    assetId: text("asset_id").references((): AnyPgColumn => gebaeudeAssets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** gesetzt bei „erledigt“/„abgelehnt“ – Beginn der Löschfrist; offene Meldungen bleiben */
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("gebaeude_tickets_number_uq").on(t.year, t.seq),
    index("gebaeude_tickets_status_idx").on(t.status),
    index("gebaeude_tickets_reporter_idx").on(t.reporterId),
    index("gebaeude_tickets_asset_idx").on(t.assetId),
  ],
);

/** Verlauf: Statuswechsel, Kommentare, Zuweisungen, Raumsperren, Fotos. */
export const gebaeudeTicketEvents = pgTable(
  "gebaeude_ticket_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => gebaeudeTickets.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    kind: gebaeudeEventKindEnum("kind").notNull(),
    statusFrom: gebaeudeStatusEnum("status_from"),
    statusTo: gebaeudeStatusEnum("status_to"),
    text: text("text"),
  },
  (t) => [index("gebaeude_ticket_events_ticket_idx").on(t.ticketId)],
);

/** Fotos einer Meldung – Metadaten beim Hochladen entfernt (Bild-Baustein src/core/images.ts). */
export const gebaeudeTicketPhotos = pgTable(
  "gebaeude_ticket_photos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => gebaeudeTickets.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gebaeude_ticket_photos_ticket_idx").on(t.ticketId)],
);

/** Zuständigkeit je Kategorie (Q-22): diese Gruppe bekommt den Gong. Ohne Eintrag gilt die Gruppe der Kategorie „gebaeude“. */
export const gebaeudeResponsibilities = pgTable("gebaeude_responsibilities", {
  category: gebaeudeCategoryEnum("category").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
});

export type GebaeudeTicket = typeof gebaeudeTickets.$inferSelect;

// ---------------------------------------------------------------- Anlagen und Prüfungen (P4-15/P4-16)

export const gebaeudeAssetConditionEnum = pgEnum("gebaeude_asset_condition", ASSET_CONDITIONS);
export const gebaeudeInspectionTargetEnum = pgEnum("gebaeude_inspection_target", INSPECTION_TARGETS);
export const gebaeudeResponsibleEnum = pgEnum("gebaeude_responsible", INSPECTION_RESPONSIBLES);
export const gebaeudeInspectionResultEnum = pgEnum("gebaeude_inspection_result", INSPECTION_RESULTS);

/**
 * INV-01: Kategorie des Inventars (statt Enum `gebaeude_asset_kind`; Vorlage `kategorien.ts`, eigene mit `template_key` null).
 * Prüfpflicht ist Eigenschaft der Kategorie; die verantwortliche Gruppe pflegt die Anlagen ihrer Kategorie. Keine Personen.
 */
export const gebaeudeAssetCategories = pgTable(
  "gebaeude_asset_categories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Schlüssel (Vorlage oder aus dem Namen), eindeutig */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Präfix der automatischen Inventarnummer, z. B. „IT“ */
    prefix: text("prefix").notNull(),
    inspectionRequired: boolean("inspection_required").notNull().default(false),
    responsibleGroupId: text("responsible_group_id").references(() => groups.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gebaeude_asset_categories_key_uq").on(t.key)],
);

/** INV-01: nächste laufende Nummer je Präfix (bzw. Präfix:Jahr) – lückenlos ohne Kollision, Format als Moduleinstellung. */
export const gebaeudeInventoryCounters = pgTable("gebaeude_inventory_counters", {
  key: text("key").primaryKey(),
  next: integer("next").notNull().default(1),
});

/**
 * Anlage/Gerät (Inventar, kein Personenbezug; INV-01). Inventarnummer eindeutig – der CSV-Import aktualisiert darüber, fehlt sie,
 * vergibt SchulOS sie aus dem Zähler der Kategorie. Standort über den Raum (Gebäude/Etage daraus) oder direkt Gebäude/Etage.
 * `quantity` > 1 = Sammelposten (Tische, Stühle je Raum). Ausgemusterte bleiben als Nachweis (`retired_on`, inv-8).
 */
export const gebaeudeAssets = pgTable(
  "gebaeude_assets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => gebaeudeAssetCategories.id),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    buildingId: text("building_id").references(() => buildings.id, { onDelete: "set null" }),
    floorId: text("floor_id").references(() => buildingFloors.id, { onDelete: "set null" }),
    inventoryNo: text("inventory_no").unique(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serial: text("serial"),
    condition: gebaeudeAssetConditionEnum("condition"),
    quantity: integer("quantity").notNull().default(1),
    priceCents: integer("price_cents"),
    /** Lieferant (Firma, keine Person) */
    supplier: text("supplier"),
    /** Finanzierung/Förderprogramm (Text) */
    financing: text("financing"),
    /** Zweckbindung bis */
    boundUntil: date("bound_until"),
    warrantyUntil: date("warranty_until"),
    acquiredOn: date("acquired_on"),
    active: boolean("active").notNull().default(true),
    retiredOn: date("retired_on"),
    retiredReason: text("retired_reason"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gebaeude_assets_category_idx").on(t.categoryId), index("gebaeude_assets_room_idx").on(t.roomId)],
);

/**
 * INV-03: Fotos je Inventargut (wie `room_photos`): auf 1600 px verkleinert, Vorschau 480 px, ohne Metadaten. Nur Sachen, keine
 * Personen (Hinweis am Upload); wer hochgeladen hat, steht nur im Audit-Log. Gehen mit dem Inventargut (cascade, Dateien löscht
 * `deleteAsset`, Reste der Dateispeicher-Lauf).
 */
export const gebaeudeAssetPhotos = pgTable(
  "gebaeude_asset_photos",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => gebaeudeAssets.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    thumbKey: text("thumb_key").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gebaeude_asset_photos_asset_idx").on(t.assetId)],
);

// ---------------------------------------------------------------- Inventur (INV-04)

export const gebaeudeInventoryItemStateEnum = pgEnum("gebaeude_inventory_item_state", INVENTORY_ITEM_STATES);
export const gebaeudeInventoryMethodEnum = pgEnum("gebaeude_inventory_method", INVENTORY_METHODS);

/**
 * INV-04: Inventur eines Raums – Soll (Inventar des Raums beim Start) gegen Ist (Scan bzw. Knopf). Je Raum höchstens eine laufende.
 * Kein Personenbezug: wer gestartet, erfasst oder abgeschlossen hat, steht nur im Audit-Log. Der Raum ist als Text mitgeschrieben,
 * damit das Protokoll als Nachweis auch nach dem Löschen des Raums lesbar bleibt.
 */
export const gebaeudeInventories = pgTable(
  "gebaeude_inventories",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
    /** Raum als Text zum Start (Kürzel, Name, Gebäude) */
    roomLabel: text("room_label").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gebaeude_inventories_room_idx").on(t.roomId), uniqueIndex("gebaeude_inventories_open_uq").on(t.roomId).where(sql`closed_at is null`)],
);

/**
 * INV-04: Posten einer Inventur. Soll-Posten (`expected`) entstehen beim Start aus dem Inventar des Raums; gescannte Geräte aus
 * anderen Räumen kommen als „falscher Raum“ dazu. Nummer, Bezeichnung und Kategorie sind mitgeschrieben (Protokoll bleibt, auch
 * wenn das Gerät später gelöscht wird). Sammelposten: gezählte Menge (`counted`).
 */
export const gebaeudeInventoryItems = pgTable(
  "gebaeude_inventory_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    inventoryId: text("inventory_id")
      .notNull()
      .references(() => gebaeudeInventories.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => gebaeudeAssets.id, { onDelete: "set null" }),
    inventoryNo: text("inventory_no"),
    name: text("name").notNull(),
    categoryName: text("category_name").notNull(),
    /** gehört laut Inventar zum Raum (Soll) */
    expected: boolean("expected").notNull(),
    /** Soll-Menge (Sammelposten), bei „falscher Raum“ die Menge laut Inventar */
    quantity: integer("quantity").notNull().default(1),
    /** gezählte Menge (nur Sammelposten; sonst null) */
    counted: integer("counted"),
    /** Raumkürzel laut Inventar beim Scan, wenn das Gerät woanders hingehört */
    homeRoomId: text("home_room_id"),
    state: gebaeudeInventoryItemStateEnum("state").notNull().default("offen"),
    method: gebaeudeInventoryMethodEnum("method"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
  },
  (t) => [index("gebaeude_inventory_items_inventory_idx").on(t.inventoryId), uniqueIndex("gebaeude_inventory_items_asset_uq").on(t.inventoryId, t.assetId)],
);

// ---------------------------------------------------------------- Ausleihe (INV-05)

/**
 * INV-05: Ausleihe eines Inventarguts (Leihgerät) an eine Person mit Konto (Schüler:innen, Beschäftigte). Personenbezug: wer hat
 * was bis wann – Löschklasse LK-ENDE-1J ab `returned_at` (offene Ausleihen bleiben). Je Gerät höchstens eine offene Ausleihe.
 * Wer verliehen bzw. zurückgenommen hat, steht nur im Audit-Log. Kontolöschung lässt eine offene Ausleihe ohne Person stehen
 * (das Gerät bleibt als „verliehen“ sichtbar, bis die Rückgabe gebucht ist). Der Leihvertrag wird nur gedruckt, nicht gespeichert.
 */
export const gebaeudeLoans = pgTable(
  "gebaeude_loans",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    assetId: text("asset_id")
      .notNull()
      .references(() => gebaeudeAssets.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    loanedOn: date("loaned_on").notNull(),
    dueOn: date("due_on").notNull(),
    /** mitgegebenes Zubehör (Sache, keine Namen), z. B. „Ladekabel, Hülle“ */
    accessories: text("accessories"),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    /** Befund bei der Rückgabe (Sache, keine Namen) */
    returnNote: text("return_note"),
    /** Fälligkeit, an die schon vorab erinnert wurde (Frist ändern → neue Erinnerung) */
    remindedDueOn: date("reminded_due_on"),
    /** Erinnerungen nach Fristende 0–3 (Frist ändern setzt zurück) */
    overdueLevel: integer("overdue_level").notNull().default(0),
    overdueOn: date("overdue_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gebaeude_loans_open_asset_uq").on(t.assetId).where(sql`returned_at is null`),
    index("gebaeude_loans_user_idx").on(t.userId),
    index("gebaeude_loans_asset_idx").on(t.assetId),
  ],
);

export type GebaeudeLoan = typeof gebaeudeLoans.$inferSelect;
export type GebaeudeInventory = typeof gebaeudeInventories.$inferSelect;
export type GebaeudeInventoryItem = typeof gebaeudeInventoryItems.$inferSelect;

/** Prüfart (Vorlage aus pruefarten.ts oder eigene). Quellen sind Hinweise „zu prüfen“ – SchulOS behauptet keine Rechtsverbindlichkeit. */
export const gebaeudeInspectionTypes = pgTable("gebaeude_inspection_types", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** Schlüssel der Vorlage (null = eigene Prüfart) */
  templateKey: text("template_key").unique(),
  name: text("name").notNull(),
  appliesTo: gebaeudeInspectionTargetEnum("applies_to").notNull(),
  /** Prüfungen werden für alle aktiven Anlagen dieser Kategorie automatisch geplant (INV-01: Kategorie statt Art) */
  categoryId: text("category_id").references(() => gebaeudeAssetCategories.id, { onDelete: "set null" }),
  intervalMonths: integer("interval_months").notNull(),
  warnDays: integer("warn_days").notNull().default(30),
  source: text("source").notNull().default(""),
  responsible: gebaeudeResponsibleEnum("responsible").notNull().default("schultraeger"),
  note: text("note"),
  /**
   * GS-02: zuständige Gruppe (z. B. Fachschaft Chemie) – bekommt Erinnerungen und Alarm-Gong, ihre Mitglieder erfassen und planen
   * Prüfungen dieser Art. Leer = wie bisher alle mit `gebaeude.manage`. Organisationsdatum, kein Personenbezug.
   */
  responsibleGroupId: text("responsible_group_id").references(() => groups.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Prüfung: offen (done_on null, fällig am due_on) oder erledigt. Nach dem Erfassen plant SchulOS die nächste
 * (letzte Prüfung + Intervall). Kein Personenbezug: Firma statt Prüfer:in, wer erfasst hat, steht nur im Audit-Log.
 */
export const gebaeudeInspections = pgTable(
  "gebaeude_inspections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    typeId: text("type_id")
      .notNull()
      .references(() => gebaeudeInspectionTypes.id),
    assetId: text("asset_id").references(() => gebaeudeAssets.id, { onDelete: "cascade" }),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    building: text("building"),
    dueOn: date("due_on").notNull(),
    doneOn: date("done_on"),
    result: gebaeudeInspectionResultEnum("result"),
    /** prüfende Firma bzw. Stelle – kein Personenname */
    company: text("company"),
    /** Protokoll-PDF im Dateispeicher */
    reportKey: text("report_key"),
    reportSize: integer("report_size"),
    note: text("note"),
    /** bei Mangel automatisch angelegte Meldung */
    ticketId: text("ticket_id").references(() => gebaeudeTickets.id, { onDelete: "set null" }),
    /** letzte Erinnerung des Fristen-Jobs (wöchentlich bei „bald fällig“, täglich bei „überfällig“) */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gebaeude_inspections_due_idx").on(t.doneOn, t.dueOn), index("gebaeude_inspections_type_idx").on(t.typeId), index("gebaeude_inspections_asset_idx").on(t.assetId)],
);

// ---------------------------------------------------------------- Wartung (P4-17)

/** Wartungstermin einer Firma, optional mit Raumsperre und Schulkalender-Eintrag. */
export const gebaeudeMaintenance = pgTable("gebaeude_maintenance", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  provider: text("provider"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  building: text("building"),
  note: text("note"),
  blocksRooms: boolean("blocks_rooms").notNull().default(false),
  calendarEventId: text("calendar_event_id").references(() => calendarEvents.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gebaeudeMaintenanceRooms = pgTable(
  "gebaeude_maintenance_rooms",
  {
    maintenanceId: text("maintenance_id")
      .notNull()
      .references(() => gebaeudeMaintenance.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    roomBlockId: text("room_block_id").references(() => timetableRoomBlocks.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.maintenanceId, t.roomId] })],
);

export type GebaeudeAsset = typeof gebaeudeAssets.$inferSelect;
export type GebaeudeAssetPhoto = typeof gebaeudeAssetPhotos.$inferSelect;
export type GebaeudeAssetCategory = typeof gebaeudeAssetCategories.$inferSelect;
export type GebaeudeInspectionType = typeof gebaeudeInspectionTypes.$inferSelect;
export type GebaeudeInspection = typeof gebaeudeInspections.$inferSelect;
