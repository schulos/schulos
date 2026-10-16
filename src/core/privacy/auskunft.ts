// Auskunft auf Knopfdruck (B-03, DS-04, Art. 15/20 DSGVO): alle Daten einer Person als ZIP (JSON + Dateien).
// Die Daten werden generisch über die Verweise auf das Konto gesammelt (refs.ts) und nach Modulen gegliedert.
// Jedes Modul kann im Manifest Spalten auslassen (Geheimnisse) – erfasst wird jede Tabelle automatisch.
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { rowsOf } from "@/core/db/rows";
import { audit, auditRead } from "@/core/audit";
import type { PermissionSet } from "@/core/permissions";
import { users } from "@/core/db/schema";
import type { FileStorage } from "@/core/files/storage";
import { collectRetention, type RetentionEntry } from "@/core/retention";
import { assertExportSize } from "@/core/export-limit";
import { createZipAsync, type ZipEntry } from "@/core/zip";
import { MODULES } from "@/modules";
import { READABLE_EXPORTS } from "@/modules/auskunft";
import { qid, refWhere, userRefs } from "./refs";

/** Spalten, die nie in eine Auskunft gehören (Zugangsgeheimnisse). */
export const EXPORT_OMIT: Record<string, string[]> = {
  accounts: ["password", "access_token", "refresh_token", "id_token"],
  sessions: ["token"],
  two_factors: ["secret", "backup_codes"],
  // Schulanmeldung: Hashes der geheimen Links (P4-34b – Anträge hängen am Elternkonto und erscheinen in dessen Auskunft)
  anmeldung_antraege: ["confirm_token_hash", "access_token_hash"],
  // Q5-15: Hash des Kalender-Abo-Links
  calendar_feed_tokens: ["token_hash"],
  // G5A-S07: Server-Schlüsselanteil des Offline-Zwischenspeichers (mit dem Geräteanteil entschlüsselbar) und die Sitzung
  notenbuch_offline_devices: ["server_share", "session_id"],
};

/** Tabellen ohne eigenen Verweis auf Personen – mit Begründung, warum die Auskunft sie nicht braucht. */
export const EXPORT_NOT_PERSONAL: Record<string, string> = {
  verifications: "Einmalcodes, laufen nach Minuten ab",
  rate_limits: "Zähler gegen Missbrauch nur als HMAC aus Zweck und IP/E-Mail, ohne Verweis auf das Konto, gelöscht mit Ablauf des Zeitfensters",
  mail_outbox: "Warteschlange der Transaktionsmails ohne Verweis auf das Konto; Empfänger und Text werden direkt nach dem Versand geleert",
  auth_throttle: "Fehlversuchszähler je Benutzername bzw. IP ohne Verweis auf das Konto, nach spätestens einem Tag gelöscht",
  chat_rooms: "Raumdaten; Mitgliedschaft und eigene Nachrichten stehen in der Auskunft",
  news_targets: "Zielgruppen einer News (Gruppen, keine Personen)",
  parent_letter_groups: "Empfängergruppen eines Elternbriefs",
  task_groups: "Gruppen einer Aufgabe",
  timetable_assignments: "Lehrauftrag; die Zuordnung zur Lehrkraft steht in der Auskunft",
  timetable_assignment_groups: "Gruppen eines Lehrauftrags",
  umfragen_targets: "Zielgruppen einer Umfrage (Rollen und Gruppen, keine Personen)",
  gebaeude_maintenance_rooms: "Räume eines Wartungstermins (keine Personen)",
  gebaeude_inspections:
    "Prüfnachweise ohne Verweis auf ein Konto; Protokoll-PDF und Bemerkung können Namen der prüfenden Person (Firma, kein Konto) enthalten und werden nach der übernächsten Prüfung geleert (G4-01)",
  kurswahl_verfahren: "Wahlverfahren (Zielgruppe, Zeitraum) ohne Personen; eigene Wahlen stehen in der Auskunft",
  sprechtag_events: "Sprechtage (Datum, Zeitraster, Buchungsfenster) ohne Personen; eigene Termine und Verfügbarkeiten stehen in der Auskunft",
  umfragen_questions: "Fragen einer Umfrage; eigene Antworten stehen in der Auskunft (namentlich) bzw. sind keiner Person zuzuordnen (anonym)",
  notenbuch_columns:
    "Leistungsnachweise eines Notenbuchs (Titel, Datum, Gewicht, Schlüssel) ohne Personen; eigene Noten und Kommentare stehen in der Auskunft der Schüler:in, die führende Lehrkraft in der Auskunft der Lehrkraft",
};

/**
 * Verweise, in denen die Person nur als Handelnde steht (SEC-05): wer eingewilligt, entschieden, ausgeblendet,
 * protokolliert hat – oder wem etwas zugewiesen wurde (Meldungen anderer, S19). Solche Zeilen gehören meist anderen
 * (Fotos und Krankmeldungen von Kindern, Meldungstexte, Audit-Ziele) – die Auskunft enthält davon nur die Tatsache der
 * Handlung (ACTOR_KEEP), nie fremde Inhalte oder Dateien.
 * Regel: Spalten `*_by`, `actor_id` und Zuordnungen (`assignee_id`, `*_assignee_id`, `assigned_to`), außer sie
 * bezeichnen eigene Inhalte (OWN_CONTENT_BY).
 */
export const OWN_CONTENT_BY = new Set([
  "file_nodes.created_by", // eigener Upload (auch im Gruppenordner)
  "task_files.uploaded_by", // eigenes Material bzw. eigene Abgabe-Datei
  "bookings.booked_by", // eigene Raumbuchung
  "parent_letter_receipts.confirmed_by", // eigene Rückmeldung als Elternteil
  "gebaeude_ticket_photos.created_by", // eigenes Foto zu einer Meldung
]);

const ACTOR_COLUMN = /^(?:actor_id|assignee_id|assigned_to)$|_assignee_id$|_by$/;

export function isActorRef(r: { table: string; column: string }): boolean {
  if (OWN_CONTENT_BY.has(`${r.table}.${r.column}`)) return false;
  return ACTOR_COLUMN.test(r.column);
}

/**
 * Zusätzlich zu `id`, der eigenen Spalte und Zeitstempeln (`*_at`) behaltene Spalten bei reinen Handlungen – fest oder
 * je Zeile (eigener Text ja, Text mit Namen Dritter nein).
 */
export const ACTOR_KEEP: Record<string, string[] | ((row: Record<string, unknown>) => string[])> = {
  audit_log: ["action"],
  // Verlauf einer Meldung: eigene Kommentare und Statuswechsel ja; „zugewiesen an <Name>“ nennt eine andere Person
  // Verlauf eines Anmeldeantrags (P4-32): nur Art und Antrag – Notizen können Namen der Familie enthalten
  anmeldung_ereignisse: ["antrag_id", "kind"],
  gebaeude_ticket_events: (row) => ["ticket_id", "kind", "status_from", "status_to", ...(row.kind === "zuweisung" ? [] : ["text"])],
};

/**
 * Dateien in der Auskunft – nur diese Spalten, und nur, wenn die Person in einer der `via`-Spalten steht (eigene Daten).
 * Jede Spalte aus STORAGE_KEY_COLUMNS (dateispeicher.ts) ist hier eingetragen (Test in auskunft.test.ts).
 */
export const EXPORT_FILES: { table: string; key: string; name: string; via: string[] }[] = [
  { table: "file_nodes", key: "storage_key", name: "name", via: ["owner_id", "created_by"] },
  { table: "task_files", key: "storage_key", name: "name", via: ["uploaded_by"] },
  { table: "profile_photos", key: "storage_key", name: "mime", via: ["user_id"] },
  { table: "parent_letters", key: "attachment_key", name: "attachment_name", via: ["author_id"] },
  { table: "gebaeude_ticket_photos", key: "storage_key", name: "mime", via: ["created_by"] },
  // Prüfprotokolle: ohne Personenbezug (Firma statt Prüfer:in, wer erfasst hat, steht nur im Audit-Log) – nie Teil einer Auskunft
  { table: "gebaeude_inspections", key: "report_key", name: "report_key", via: [] },
  // Q5-12: Vertretungsmaterial – eigene Uploads
  { table: "timetable_absence_materials", key: "file_key", name: "file_name", via: ["created_by"] },
];

export interface ExportSection {
  owner: string;
  table: string;
  purpose: string;
  categories: string[];
  /** true: Zeilen, in denen die Person nur gehandelt hat (ohne fremde Inhalte) */
  asActor?: boolean;
  rows: Record<string, unknown>[];
}

export interface PersonalData {
  person: { id: string; name: string; username: string | null; role: string };
  sections: ExportSection[];
  files: { path: string; storageKey: string; size: number }[];
  /** G5A-S01: Teile, die mangels Berechtigung der erzeugenden Person fehlen (Hinweis je Modul) */
  withheld: { module: string; note: string }[];
  /** enthaltene eingeschränkte Teile (für den Lesevermerk) */
  included: { module: string; readAction: `lesen.${string}`; rows: number }[];
}

export interface CollectOptions {
  /**
   * Rechte der erzeugenden Person – eingeschränkte Teile (READABLE_EXPORTS[].restricted, z. B. Noten) nur, wenn sie das
   * ausdrückliche Recht hat und `secondFactor` nicht false ist. Ohne Angabe: ohne diese Teile (sicherer Standard).
   */
  actor?: PermissionSet | null;
  /** Sitzung der erzeugenden Person mit zweitem Faktor angemeldet (wie im Notenbuch verlangt) */
  secondFactor?: boolean;
}

function declarations(entries: readonly RetentionEntry[]) {
  const m = new Map<string, RetentionEntry>();
  for (const e of entries) if (!m.has(e.decl.table)) m.set(e.decl.table, e);
  return m;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "datei";

const photoName = (mime: unknown, base = "profilbild") => `${base}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;

type Hit = { row: Record<string, unknown>; cols: Set<string> };

/** Sammelt alle Datensätze mit Bezug auf die Person (ohne Zugangsgeheimnisse, ohne Daten Dritter aus reinen Handlungen). */
export async function collectPersonalData(db: Db, userId: string, opts: CollectOptions = {}): Promise<PersonalData | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const decl = declarations(collectRetention(MODULES));
  // G5A-S01: eingeschränkte Teile nur mit ausdrücklichem Recht der erzeugenden Person
  const mayInclude = (x: (typeof READABLE_EXPORTS)[number]) =>
    !x.restricted || Boolean(opts.actor && opts.secondFactor !== false && x.restricted.allowed(opts.actor));
  const restrictedTables = new Set(READABLE_EXPORTS.filter((x) => !mayInclude(x)).flatMap((x) => x.restricted!.tables));
  // je Tabelle und Zeile: die Zeile und die Spalten, über die die Person gefunden wurde
  const byTable = new Map<string, Map<string, Hit>>();
  const add = (table: string, rows: Record<string, unknown>[], column: string) => {
    const m = byTable.get(table) ?? new Map<string, Hit>();
    for (const r of rows) {
      const k = JSON.stringify(r.id ?? r);
      const hit = m.get(k) ?? { row: r, cols: new Set<string>() };
      hit.cols.add(column);
      m.set(k, hit);
    }
    byTable.set(table, m);
  };
  add("users", [u as unknown as Record<string, unknown>], "id");
  for (const r of userRefs()) {
    const res = await db.execute(sql`select * from ${qid(r.table)} where ${refWhere(r, userId)}`);
    const rows = rowsOf<Record<string, unknown>>(res);
    if (rows.length) add(r.table, rows, r.column);
  }

  const sections: ExportSection[] = [];
  const files: PersonalData["files"] = [];
  for (const [table, rowMap] of byTable) {
    const omit = new Set(EXPORT_OMIT[table] ?? []);
    const d = decl.get(table);
    const own: Record<string, unknown>[] = [];
    const acted: Record<string, unknown>[] = [];
    for (const { row, cols } of rowMap.values()) {
      if ([...cols].some((c) => !isActorRef({ table, column: c }))) {
        if (restrictedTables.has(table)) continue;
        const r = Object.fromEntries(Object.entries(row).filter(([k]) => !omit.has(k)));
        own.push(r);
        for (const f of EXPORT_FILES) {
          if (f.table !== table || typeof r[f.key] !== "string" || !f.via.some((v) => cols.has(v))) continue;
          const label = f.name === "mime" ? photoName(r.mime, table === "profile_photos" ? "profilbild" : "foto") : String(r[f.name] ?? "datei");
          const size = Number(r.size ?? r.attachment_size ?? 0);
          files.push({ path: `dateien/${table}/${String(r.id).slice(0, 8)}_${safeName(label)}`, storageKey: r[f.key] as string, size });
        }
      } else {
        // nur die eigene Handlung: wann und was – keine Inhalte, Ziele oder Dateien Dritter
        const extra = ACTOR_KEEP[table];
        const keep = new Set(["id", ...cols, ...(typeof extra === "function" ? extra(row) : (extra ?? []))]);
        acted.push(Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k) || k.endsWith("_at"))));
      }
    }
    const base = { owner: d?.owner ?? "core", table, purpose: d?.decl.purpose ?? table, categories: d?.decl.categories ?? [] };
    if (own.length) sections.push({ ...base, rows: own });
    if (acted.length) sections.push({ ...base, purpose: `${base.purpose} (nur eigene Handlungen)`, asActor: true, rows: acted });
  }
  // lesbare Zusammenstellungen der Module (z. B. Noten mit Fach und Leistung, P5-15) – zusätzlich zu den Rohdaten
  const withheld: PersonalData["withheld"] = [];
  const included: PersonalData["included"] = [];
  for (const x of READABLE_EXPORTS) {
    const allowed = mayInclude(x);
    let hidden = 0;
    let shown = 0;
    for (const sec of await x.build(db, userId)) {
      if (!sec.rows.length) continue;
      const restricted = x.restricted?.sections.includes(sec.table) ?? false;
      if (restricted && !allowed) {
        hidden += sec.rows.length;
        continue;
      }
      if (restricted) shown += sec.rows.length;
      sections.push({ owner: x.moduleId, ...sec });
    }
    if (x.restricted && hidden) withheld.push({ module: x.moduleId, note: x.restricted.note });
    if (x.restricted && shown) included.push({ module: x.moduleId, readAction: x.restricted.readAction, rows: shown });
  }
  sections.sort((a, b) => a.owner.localeCompare(b.owner) || a.table.localeCompare(b.table) || Number(!!a.asActor) - Number(!!b.asActor));
  return { person: { id: u.id, name: u.name, username: u.username, role: u.role }, sections, files, withheld, included };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
}

function readme(data: PersonalData, createdAt: Date, missing: number): string {
  const lines = [
    `Auskunft nach Art. 15 DSGVO – ${data.person.name}`,
    `Erstellt: ${createdAt.toISOString()}`,
    "",
    "Inhalt:",
    "- uebersicht.json: Zwecke und Datenkategorien je Datenart, Anzahl der Datensätze",
    "- daten/<modul>/<tabelle>.json: die Datensätze im maschinenlesbaren Format (Art. 20)",
    "- daten/<modul>/<tabelle>.handlungen.json: wo die Person nur gehandelt hat (z. B. entschieden, eingewilligt) – nur Zeitpunkt und Art",
    "- dateien/: eigene Dateien und Uploads",
    "",
    "Nicht enthalten sind Zugangsgeheimnisse (Passwort-Hash, Sitzungsschlüssel) sowie Daten, die anderen Personen gehören.",
    "Speicherfristen und Empfänger stehen in den Datenschutzhinweisen der Schule.",
  ];
  if (missing) lines.push("", `Hinweis: ${missing} Datei(en) fehlten im Speicher und konnten nicht beigelegt werden.`);
  for (const w of data.withheld) lines.push("", `Hinweis (${w.module}): ${w.note}`);
  return lines.join("\n") + "\n";
}

/** Erzeugt das Auskunfts-ZIP. Es wird nur ausgeliefert, nicht auf dem Server abgelegt; der Vorgang steht im Audit-Log. */
export async function buildDataExport(
  db: Db,
  storage: FileStorage,
  actorId: string,
  userId: string,
  now = new Date(),
  opts: CollectOptions = {},
): Promise<{ filename: string; zip: Uint8Array; withheld: string[] } | null> {
  const data = await collectPersonalData(db, userId, opts);
  if (!data) return null;
  assertExportSize(data.files.reduce((sum, f) => sum + f.size, 0));
  const paths = new Set<string>();
  const files = data.files.filter((f) => !paths.has(f.path) && !!paths.add(f.path));
  let missing = 0;
  // Dateien einzeln lesen und im Thread-Pool komprimieren (SEC-05)
  async function* entries(d: PersonalData): AsyncGenerator<ZipEntry> {
    for (const s of d.sections) yield { name: `daten/${s.owner}/${s.table}${s.asActor ? ".handlungen" : ""}.json`, data: json(s.rows), modifiedAt: now };
    for (const f of files) {
      const stream = await storage.get(f.storageKey);
      if (!stream) {
        missing++;
        continue;
      }
      yield { name: f.path, data: new Uint8Array(await new Response(stream).arrayBuffer()), modifiedAt: now };
    }
    yield { name: "LIESMICH.txt", data: new TextEncoder().encode(readme(d, now, missing)), modifiedAt: now };
    yield {
      name: "uebersicht.json",
      data: json({
        person: d.person,
        createdAt: now.toISOString(),
        sections: d.sections.map((s) => ({ module: s.owner, table: s.table, onlyActions: !!s.asActor, purpose: s.purpose, categories: s.categories, count: s.rows.length })),
        files: files.length - missing,
        notIncluded: d.withheld,
      }),
      modifiedAt: now,
    };
  }
  const zip = await createZipAsync(entries(data));
  await audit(db, actorId, "datenschutz.auskunft", userId, {
    sections: data.sections.length,
    files: files.length - missing,
    ...(data.withheld.length ? { ohne: data.withheld.map((w) => w.module) } : {}),
  });
  // G5A-S01: Lesevermerk für eingeschränkte Teile (z. B. Noten) – wer sie wann für wen erteilt hat
  for (const i of data.included) await auditRead(db, actorId, i.readAction, `auskunft:${userId}`, { modul: i.module, eintraege: i.rows }, now);
  const stamp = now.toISOString().slice(0, 10);
  return { filename: `auskunft_${data.person.username ?? data.person.id}_${stamp}.zip`, zip, withheld: data.withheld.map((w) => w.module) };
}
