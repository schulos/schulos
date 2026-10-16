// Gebäude & Technik (P4-11) – nur relative Imports (drizzle-kit).
import { boolean, date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "../../core/db/schema-auth";
import { groups, rooms } from "../../core/db/schema-core";
import { calendarEvents } from "../kalender/schema";
import { timetableRoomBlocks } from "../stundenplan/schema";
import {
  ASSET_KINDS,
  INSPECTION_RESPONSIBLES,
  INSPECTION_RESULTS,
  INSPECTION_TARGETS,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** gesetzt bei „erledigt“/„abgelehnt“ – Beginn der Löschfrist; offene Meldungen bleiben */
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("gebaeude_tickets_number_uq").on(t.year, t.seq),
    index("gebaeude_tickets_status_idx").on(t.status),
    index("gebaeude_tickets_reporter_idx").on(t.reporterId),
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

export const gebaeudeAssetKindEnum = pgEnum("gebaeude_asset_kind", ASSET_KINDS);
export const gebaeudeInspectionTargetEnum = pgEnum("gebaeude_inspection_target", INSPECTION_TARGETS);
export const gebaeudeResponsibleEnum = pgEnum("gebaeude_responsible", INSPECTION_RESPONSIBLES);
export const gebaeudeInspectionResultEnum = pgEnum("gebaeude_inspection_result", INSPECTION_RESULTS);

/** Anlage/Gerät (Inventar, kein Personenbezug). Inventarnummer eindeutig – der CSV-Import aktualisiert darüber. */
export const gebaeudeAssets = pgTable("gebaeude_assets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  kind: gebaeudeAssetKindEnum("kind").notNull(),
  roomId: text("room_id").references(() => rooms.id, { onDelete: "set null", onUpdate: "cascade" }),
  building: text("building"),
  inventoryNo: text("inventory_no").unique(),
  manufacturer: text("manufacturer"),
  serial: text("serial"),
  acquiredOn: date("acquired_on"),
  active: boolean("active").notNull().default(true),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Prüfart (Vorlage aus pruefarten.ts oder eigene). Quellen sind Hinweise „zu prüfen“ – SchulOS behauptet keine Rechtsverbindlichkeit. */
export const gebaeudeInspectionTypes = pgTable("gebaeude_inspection_types", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  /** Schlüssel der Vorlage (null = eigene Prüfart) */
  templateKey: text("template_key").unique(),
  name: text("name").notNull(),
  appliesTo: gebaeudeInspectionTargetEnum("applies_to").notNull(),
  /** Prüfungen werden für alle aktiven Anlagen dieser Art automatisch geplant */
  assetKind: gebaeudeAssetKindEnum("asset_kind"),
  intervalMonths: integer("interval_months").notNull(),
  warnDays: integer("warn_days").notNull().default(30),
  source: text("source").notNull().default(""),
  responsible: gebaeudeResponsibleEnum("responsible").notNull().default("schultraeger"),
  note: text("note"),
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
export type GebaeudeInspectionType = typeof gebaeudeInspectionTypes.$inferSelect;
export type GebaeudeInspection = typeof gebaeudeInspections.$inferSelect;
