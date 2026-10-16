// Schulanmeldung – Entscheidung und Export (P4-37). Die Schulleitung entscheidet einzeln oder für eine Auswahl
// (aufgenommen / Warteliste / abgelehnt); Kapazität, Geschwister und Wohnort sind nur Information – SchulOS wählt nicht
// automatisch aus und lost nicht (Q-34). Eltern bekommen nach der ersten Entscheidung nur „Bescheid folgt per Post“ (Q-35).
// Exporte: CSV für die Schulverwaltungssoftware (Spalten wählbar, UTF-8 oder Windows-1252) und Serienbrief-CSV für die
// Bescheide; beides im Audit-Log (ohne Personendaten).
import { and, asc, eq, inArray } from "drizzle-orm";
import { audit } from "@/core/audit";
import { csvBytes, type CsvEncoding, CSV_ENCODINGS } from "@/core/csv";
import type { Db } from "@/core/db/client";
import { anmeldungAntraege, anmeldungEreignisse, anmeldungSlots, anmeldungVerfahren } from "@/core/db/schema";
import { de } from "@/core/db/sort";
import { enqueueMail } from "@/core/mail";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { TZ } from "@/core/time";
import { ValidationError } from "@/modules/verwaltung/users";
import { ANTRAG_STATUS_LABELS, type AntragStatus } from "./labels";
import { anmeldungDecisionMail } from "./mails";
import {
  antragNumber,
  canDecide,
  canManage,
  canTransition,
  canView,
  capacitySummary,
  DECISION_STATUSES,
  isLateAdmission,
  lateAdmissionBlocker,
  OPEN_STATUSES,
  requiredRight,
  setAntragStatus,
  type CapacitySummary,
} from "./service";

export type Decision = "aufgenommen" | "warteliste" | "abgelehnt";
export const DECISIONS: readonly Decision[] = ["aufgenommen", "warteliste", "abgelehnt"];

/** Höchstens so viele Anträge je Listenentscheidung (ein Klick, eine Transaktion je Antrag). */
export const DECIDE_MAX = 500;

// ---------------------------------------------------------------- Entscheidungsliste

export interface DecisionRow {
  id: string;
  number: string;
  childFirstName: string;
  childLastName: string;
  childBirthDate: string;
  primarySchool: string | null;
  sibling: boolean;
  siblingNote: string | null;
  /** Wohnort nur als Information (Schulweg-Kriterium, § 1 Abs. 2 APO-S I) – keine Berechnung */
  zip: string | null;
  city: string | null;
  status: AntragStatus;
  /** alle Unterlagen vorgelegt (Status „vollständig“ oder schon entschieden nach vollständiger Checkliste) */
  documentsComplete: boolean;
  decidedAt: Date | null;
  /** P4-78: als Spam abgelehnt */
  spam: boolean;
  /** P4-78b: vom Sekretariat als Spam-Verdacht markiert */
  spamSuspect: boolean;
}

/** Bestätigte Anträge eines Verfahrens zur Entscheidung (ohne unbestätigte und zurückgezogene), deutsch nach Namen sortiert. */
export async function decisionList(db: Db, viewer: PermissionSet, verfahrenId: string): Promise<{ rows: DecisionRow[]; capacity: CapacitySummary }> {
  if (!canView(viewer)) throw new ForbiddenError("anmeldung.view");
  const rows = await db
    .select()
    .from(anmeldungAntraege)
    .where(and(eq(anmeldungAntraege.verfahrenId, verfahrenId), inArray(anmeldungAntraege.status, [...OPEN_STATUSES, ...DECISION_STATUSES])))
    .orderBy(de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName), asc(anmeldungAntraege.seq));
  return {
    rows: rows.map((a) => {
      const checklist = (a.checklist ?? {}) as Record<string, boolean>;
      const values = Object.values(checklist);
      return {
        id: a.id,
        number: antragNumber(a.year, a.seq),
        childFirstName: a.childFirstName,
        childLastName: a.childLastName,
        childBirthDate: a.childBirthDate,
        primarySchool: a.primarySchool,
        sibling: a.sibling,
        siblingNote: a.siblingNote,
        zip: a.addressZip,
        city: a.addressCity,
        status: a.status,
        documentsComplete: a.status === "vollstaendig" || (values.length > 0 && values.every(Boolean)),
        decidedAt: a.decidedAt,
        spam: a.rejectedAsSpam,
        spamSuspect: a.spamSuspectedAt !== null,
      };
    }),
    capacity: await capacitySummary(db, verfahrenId),
  };
}

// ---------------------------------------------------------------- Entscheiden

/**
 * Entscheidung für einen oder mehrere Anträge desselben Verfahrens. Prüft vorab alle Übergänge (sonst ändert sich nichts),
 * setzt dann je Antrag den Status über die Statusmaschine (Recht `anmeldung.decide`, Verlauf, Fristbeginn) und schickt nach
 * der **ersten** Entscheidung eine Mail ohne Ergebnis (Q-35). Korrekturen (z. B. Warteliste → aufgenommen) lösen keine
 * weitere Mail aus. Anträge, die schon so entschieden sind, werden übersprungen – außer als Spam abgelehnte bei „abgelehnt“
 * (G4D-C04: Korrektur des Irrtums mit Mail).
 */
export async function decide(
  db: Db,
  viewer: PermissionSet,
  verfahrenId: string,
  antragIds: readonly string[],
  to: Decision,
  ctx: { school: string; note?: string | null; now?: Date },
): Promise<{ changed: number; skipped: number; mails: number }> {
  if (!canDecide(viewer)) throw new ForbiddenError("anmeldung.decide");
  if (!DECISIONS.includes(to)) throw new ValidationError({ decision: "Entscheidung wählen" });
  const ids = [...new Set(antragIds.map((i) => i.trim()).filter(Boolean))];
  if (!ids.length) throw new ValidationError({ antraege: "Bitte mindestens einen Antrag auswählen" });
  if (ids.length > DECIDE_MAX) throw new ValidationError({ antraege: `Höchstens ${DECIDE_MAX} Anträge auf einmal` });
  const now = ctx.now ?? new Date();
  const [v] = await db
    .select({ status: anmeldungVerfahren.status, targetSchoolYearId: anmeldungVerfahren.targetSchoolYearId })
    .from(anmeldungVerfahren)
    .where(eq(anmeldungVerfahren.id, verfahrenId));
  if (!v) throw new ValidationError({ verfahren: "Verfahren gibt es nicht" });
  const rows = await db.select().from(anmeldungAntraege).where(and(inArray(anmeldungAntraege.id, ids), eq(anmeldungAntraege.verfahrenId, verfahrenId)));
  if (rows.length !== ids.length) throw new ValidationError({ antraege: "Mindestens ein Antrag gehört nicht zu diesem Verfahren" });
  if (v.status === "abgeschlossen") {
    // Q5-19: nach dem Abschluss nur Nachrücken von der Warteliste, bis zum Beginn des Zielschuljahres
    if (to !== "aufgenommen" || rows.some((a) => a.status !== to && !isLateAdmission(a.status, to)))
      throw new ValidationError({ verfahren: "Das Verfahren ist abgeschlossen – nur noch Nachrücken von der Warteliste" });
    const blocked = await lateAdmissionBlocker(db, v, now);
    if (blocked) throw new ValidationError({ verfahren: blocked });
  }
  const blocked = rows.filter((a) => a.status !== to && (!canTransition(a.status, to) || requiredRight(a.status, to) === "system"));
  if (blocked.length)
    throw new ValidationError({
      antraege: `Nicht möglich für ${blocked
        .slice(0, 5)
        .map((a) => `${antragNumber(a.year, a.seq)} (${ANTRAG_STATUS_LABELS[a.status]})`)
        .join(", ")}${blocked.length > 5 ? " …" : ""}`,
    });
  let changed = 0;
  let mails = 0;
  for (const a of rows) {
    // G4D-C04 (Q-4D-35): „abgelehnt“ auf einen als Spam abgelehnten Antrag ist keine Wiederholung, sondern die Korrektur
    // des Irrtums – Spam-Kennzeichen weg, Grund neu, Mail und Bescheid wie bei jeder ersten echten Entscheidung
    const spamFix = a.rejectedAsSpam && a.status === to;
    if (a.status === to && !spamFix) continue;
    // P4-78: ein irrtümlich als Spam abgelehnter Antrag bekommt bei der ersten echten Entscheidung seine Mail
    const first = (!a.decidedAt && (OPEN_STATUSES as readonly string[]).includes(a.status)) || a.rejectedAsSpam;
    if (spamFix) {
      const note = ctx.note?.trim().slice(0, 1000) || null;
      const done = await db
        .update(anmeldungAntraege)
        .set({ rejectedAsSpam: false, spamSuspectedAt: null, spamSuspectedBy: null, decisionNote: note, decidedAt: now, decidedBy: viewer.userId, updatedAt: now })
        .where(and(eq(anmeldungAntraege.id, a.id), eq(anmeldungAntraege.status, to), eq(anmeldungAntraege.rejectedAsSpam, true)))
        .returning({ id: anmeldungAntraege.id });
      if (!done.length) continue;
      await db.insert(anmeldungEreignisse).values({ antragId: a.id, actorId: viewer.userId, kind: "status", text: "Spam-Kennzeichen aufgehoben – regulär abgelehnt", at: now });
      await audit(db, viewer.userId, "anmeldung.antrag.status", a.id, { von: a.status, nach: to, spamAufgehoben: true });
    } else await setAntragStatus(db, viewer, a.id, to, { now, note: ctx.note, from: a.status });
    // P4-78/P4-78b: echte Entscheidung hebt Spam-Kennzeichen und Spam-Verdacht auf
    if (a.rejectedAsSpam || a.spamSuspectedAt)
      await db.update(anmeldungAntraege).set({ rejectedAsSpam: false, spamSuspectedAt: null, spamSuspectedBy: null }).where(eq(anmeldungAntraege.id, a.id));
    changed++;
    if (first) {
      await enqueueMail(db, { to: a.parent1Email, ...anmeldungDecisionMail({ school: ctx.school, number: antragNumber(a.year, a.seq) }), purpose: "anmeldung-entscheidung" }, now);
      await db.insert(anmeldungEreignisse).values({ antragId: a.id, actorId: viewer.userId, kind: "mail", text: "Mail: Entscheidung liegt vor (ohne Ergebnis)", at: now });
      mails++;
    }
  }
  if (ids.length > 1) await audit(db, viewer.userId, "anmeldung.entscheidung.liste", verfahrenId, { nach: to, anzahl: changed });
  return { changed, skipped: rows.length - changed, mails };
}

/** Grund, der bei der Sammel-Ablehnung als Notiz zur Entscheidung steht. */
export const SPAM_NOTE = "Spam";

/** P4-78b: Recht, Anträge als Spam-Verdacht zu markieren (Vorgabe Sekretariat/Verwaltung) – ablehnen bleibt `anmeldung.decide`. */
export const SPAM_MARK = "anmeldung.spam";
/** Spam-Schritte der Antragsliste */
export type SpamOp = "ablehnen" | "markieren" | "zuruecknehmen";
export const canMarkSpam = (v: PermissionSet) => !v.locked && (hasPermission(v, SPAM_MARK) || canDecide(v));

/** Gemeinsame Vorprüfung der Spam-Schritte: Auswahl, Verfahren offen, alle Anträge gehören dazu und sind offen. */
async function openSelection(db: Db, verfahrenId: string, antragIds: readonly string[], verb: string, opts: { accountAllowed?: boolean } = {}) {
  const ids = [...new Set(antragIds.map((i) => i.trim()).filter(Boolean))];
  if (!ids.length) throw new ValidationError({ antraege: "Bitte mindestens einen Antrag auswählen" });
  if (ids.length > DECIDE_MAX) throw new ValidationError({ antraege: `Höchstens ${DECIDE_MAX} Anträge auf einmal` });
  const [v] = await db.select({ status: anmeldungVerfahren.status }).from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, verfahrenId));
  if (!v) throw new ValidationError({ verfahren: "Verfahren gibt es nicht" });
  if (v.status === "abgeschlossen") throw new ValidationError({ verfahren: "Das Verfahren ist abgeschlossen" });
  const rows = await db.select().from(anmeldungAntraege).where(and(inArray(anmeldungAntraege.id, ids), eq(anmeldungAntraege.verfahrenId, verfahrenId)));
  if (rows.length !== ids.length) throw new ValidationError({ antraege: "Mindestens ein Antrag gehört nicht zu diesem Verfahren" });
  const blocked = rows.filter((a) => !(OPEN_STATUSES as readonly string[]).includes(a.status));
  if (blocked.length)
    throw new ValidationError({
      antraege: `Nur offene Anträge lassen sich ${verb} – nicht ${blocked
        .slice(0, 5)
        .map((a) => `${antragNumber(a.year, a.seq)} (${ANTRAG_STATUS_LABELS[a.status]})`)
        .join(", ")}${blocked.length > 5 ? " …" : ""}`,
    });
  // G4D-S04 (Q-4D-34): Anträge aus einem Elternkonto (geprüfte Adresse) sind kein Spam – sie werden regulär entschieden
  const account = opts.accountAllowed ? [] : rows.filter((a) => a.parentUserId);
  if (account.length)
    throw new ValidationError({
      antraege: `Antrag aus einem Elternkonto – bitte regulär entscheiden: ${account
        .slice(0, 5)
        .map((a) => antragNumber(a.year, a.seq))
        .join(", ")}${account.length > 5 ? " …" : ""}`,
    });
  return rows;
}

/**
 * P4-78 (GATE-4c Security M1): Sammel-Ablehnung „Spam“ aus der Antragsliste. Nur offene, bestätigte Anträge (eingegangen,
 * Termin, Unterlagen vollständig); Recht `anmeldung.decide` – auch Spam abzulehnen ist eine Ablehnung (§ 46 SchulG NRW).
 * Nur Anträge ohne Elternkonto (G4D-S04). Keine Mail an die angegebene Adresse (sie gehört oft Unbeteiligten), Grund „Spam“, Verlauf je Antrag und ein Audit-Eintrag
 * für die Liste. Die Anträge zählen nicht für Serienbrief und Export; Löschung wie abgelehnte Anträge. Keine Domain-Grenze,
 * kein Captcha (erst bei echtem Missbrauch). Prüft vorab alle Anträge – sonst ändert sich nichts. P4-78b: so bestätigt die
 * Schulleitung den Spam-Verdacht des Sekretariats (die Markierung fällt dabei weg).
 */
export async function rejectAsSpam(db: Db, viewer: PermissionSet, verfahrenId: string, antragIds: readonly string[], now = new Date()): Promise<number> {
  if (!canDecide(viewer)) throw new ForbiddenError("anmeldung.decide");
  const rows = await openSelection(db, verfahrenId, antragIds, "als Spam ablehnen");
  // G4D-C06: alles oder nichts – ändert sich ein Antrag inzwischen (CHANGED_MEANWHILE), bleibt die ganze Auswahl, wie sie war
  await db.transaction(async (tx) => {
    for (const a of rows) {
      await setAntragStatus(tx, viewer, a.id, "abgelehnt", { now, note: SPAM_NOTE, from: a.status });
      await tx.update(anmeldungAntraege).set({ rejectedAsSpam: true, spamSuspectedAt: null, spamSuspectedBy: null }).where(eq(anmeldungAntraege.id, a.id));
      await tx.insert(anmeldungEreignisse).values({ antragId: a.id, actorId: viewer.userId, kind: "notiz", text: "Als Spam abgelehnt – keine Mail an die angegebene Adresse", at: now });
    }
    await audit(tx, viewer.userId, "anmeldung.spam", verfahrenId, { anzahl: rows.length });
  });
  return rows.length;
}

/**
 * P4-78b (Q-4D-6, zweistufig): Sekretariat markiert offene Anträge als **Spam-Verdacht** – der Stand bleibt, keine Mail,
 * Verlauf je Antrag und ein Audit-Eintrag ohne Namen. Die Schulleitung bestätigt gesammelt (`rejectAsSpam`) oder nimmt die
 * Markierung zurück. Schon markierte Anträge zählen nicht doppelt.
 */
export async function markSpamSuspect(db: Db, viewer: PermissionSet, verfahrenId: string, antragIds: readonly string[], now = new Date()): Promise<number> {
  if (!canMarkSpam(viewer)) throw new ForbiddenError(SPAM_MARK);
  const rows = (await openSelection(db, verfahrenId, antragIds, "als Spam-Verdacht markieren")).filter((a) => !a.spamSuspectedAt);
  for (const a of rows) {
    await db.update(anmeldungAntraege).set({ spamSuspectedAt: now, spamSuspectedBy: viewer.userId }).where(eq(anmeldungAntraege.id, a.id));
    await db.insert(anmeldungEreignisse).values({ antragId: a.id, actorId: viewer.userId, kind: "notiz", text: "Als Spam-Verdacht markiert – die Schulleitung entscheidet", at: now });
  }
  if (rows.length) await audit(db, viewer.userId, "anmeldung.spam.verdacht", verfahrenId, { anzahl: rows.length });
  return rows.length;
}

/** P4-78b: Spam-Verdacht zurücknehmen (wer markieren darf, auch die Schulleitung). Nicht markierte Anträge bleiben unverändert. */
export async function unmarkSpamSuspect(db: Db, viewer: PermissionSet, verfahrenId: string, antragIds: readonly string[], now = new Date()): Promise<number> {
  if (!canMarkSpam(viewer)) throw new ForbiddenError(SPAM_MARK);
  const rows = (await openSelection(db, verfahrenId, antragIds, "zurücknehmen", { accountAllowed: true })).filter((a) => a.spamSuspectedAt);
  for (const a of rows) {
    await db.update(anmeldungAntraege).set({ spamSuspectedAt: null, spamSuspectedBy: null }).where(eq(anmeldungAntraege.id, a.id));
    await db.insert(anmeldungEreignisse).values({ antragId: a.id, actorId: viewer.userId, kind: "notiz", text: "Spam-Verdacht zurückgenommen", at: now });
  }
  if (rows.length) await audit(db, viewer.userId, "anmeldung.spam.verdacht.zurueck", verfahrenId, { anzahl: rows.length });
  return rows.length;
}

// ---------------------------------------------------------------- Export

/** Spalten des Exports für die Schulverwaltungssoftware (Schlüssel stabil – Auswahl wird so übergeben). */
export const EXPORT_COLUMNS = [
  { key: "nummer", label: "Vorgangsnummer" },
  { key: "status", label: "Stand" },
  { key: "nachname", label: "Nachname" },
  { key: "vorname", label: "Vorname" },
  { key: "geburtsdatum", label: "Geburtsdatum" },
  { key: "grundschule", label: "Grundschule" },
  { key: "geschwister", label: "Geschwisterkind" },
  { key: "geschwister_hinweis", label: "Geschwisterkind (Name/Klasse)" },
  { key: "zweitwunsch", label: "Zweitwunsch" },
  { key: "eltern1", label: "Elternteil 1" },
  { key: "eltern2", label: "Elternteil 2" },
  { key: "strasse", label: "Straße" },
  { key: "plz", label: "PLZ" },
  { key: "ort", label: "Ort" },
  { key: "telefon", label: "Telefon" },
  { key: "email", label: "E-Mail" },
  { key: "email2", label: "E-Mail Elternteil 2" },
  { key: "termin", label: "Gesprächstermin" },
  { key: "entschieden_am", label: "Entschieden am" },
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number]["key"];

/** Vorauswahl: was eine Schulverwaltungssoftware für die Aufnahme braucht (ohne Stand, Termin, Zweitwunsch). */
export const DEFAULT_EXPORT_COLUMNS: readonly ExportColumn[] = ["nummer", "nachname", "vorname", "geburtsdatum", "grundschule", "eltern1", "eltern2", "strasse", "plz", "ort", "telefon", "email"];

/** Welche Anträge exportiert werden: nur aufgenommene (Vorgabe), alle entschiedenen oder alle bestätigten. */
export const EXPORT_SCOPES = ["aufgenommen", "entschieden", "alle"] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];
export const EXPORT_SCOPE_LABELS: Record<ExportScope, string> = {
  aufgenommen: "nur aufgenommene",
  entschieden: "alle entschiedenen (aufgenommen, Warteliste, abgelehnt)",
  alle: "alle bestätigten Anträge",
};

const scopeStatuses = (s: ExportScope): AntragStatus[] =>
  s === "aufgenommen" ? ["aufgenommen", "uebernommen"] : s === "entschieden" ? [...DECISION_STATUSES, "uebernommen"] : [...OPEN_STATUSES, ...DECISION_STATUSES, "uebernommen"];

const dmy = (ymd: string) => ymd.split("-").reverse().join(".");
const dayFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ });
const dtFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });

export interface ExportOptions {
  columns: readonly string[];
  encoding: string;
  scope: string;
}

function normalizeExport(o: ExportOptions): { columns: ExportColumn[]; encoding: CsvEncoding; scope: ExportScope } {
  const keys = EXPORT_COLUMNS.map((c) => c.key as string);
  const columns = keys.filter((k) => o.columns.includes(k)) as ExportColumn[];
  if (!columns.length) throw new ValidationError({ columns: "Mindestens eine Spalte wählen" });
  const encoding = (CSV_ENCODINGS as readonly string[]).includes(o.encoding) ? (o.encoding as CsvEncoding) : "utf8";
  const scope = (EXPORT_SCOPES as readonly string[]).includes(o.scope) ? (o.scope as ExportScope) : "aufgenommen";
  return { columns, encoding, scope };
}

async function loadVerfahrenName(db: Db, id: string) {
  const [v] = await db.select({ id: anmeldungVerfahren.id, name: anmeldungVerfahren.name }).from(anmeldungVerfahren).where(eq(anmeldungVerfahren.id, id));
  if (!v) throw new ValidationError({ verfahren: "Verfahren gibt es nicht" });
  return v;
}

const fileSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "verfahren";

/**
 * CSV für die Schulverwaltungssoftware (Recht `anmeldung.manage`): gewählte Spalten in fester Reihenfolge, Semikolon,
 * UTF-8 mit BOM oder Windows-1252. Zellen gegen Formeln entschärft (`toCsv`). Protokolliert ohne Personendaten.
 */
export async function exportSvsCsv(db: Db, viewer: PermissionSet, verfahrenId: string, opts: ExportOptions, now = new Date()) {
  if (!canManage(viewer)) throw new ForbiddenError("anmeldung.manage");
  const v = await loadVerfahrenName(db, verfahrenId);
  const { columns, encoding, scope } = normalizeExport(opts);
  const rows = await db
    .select({ a: anmeldungAntraege, slotStartsAt: anmeldungSlots.startsAt })
    .from(anmeldungAntraege)
    .leftJoin(anmeldungSlots, eq(anmeldungSlots.id, anmeldungAntraege.slotId))
    // P4-78: als Spam abgelehnte Anträge gehören nicht in die Schulverwaltungssoftware
    .where(and(eq(anmeldungAntraege.verfahrenId, verfahrenId), inArray(anmeldungAntraege.status, scopeStatuses(scope)), eq(anmeldungAntraege.rejectedAsSpam, false)))
    .orderBy(de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName), asc(anmeldungAntraege.seq));
  const cell = (a: (typeof rows)[number]["a"], slot: Date | null, k: ExportColumn): string => {
    switch (k) {
      case "nummer":
        return antragNumber(a.year, a.seq);
      case "status":
        return ANTRAG_STATUS_LABELS[a.status];
      case "nachname":
        return a.childLastName;
      case "vorname":
        return a.childFirstName;
      case "geburtsdatum":
        return dmy(a.childBirthDate);
      case "grundschule":
        return a.primarySchool ?? "";
      case "geschwister":
        return a.sibling ? "ja" : "nein";
      case "geschwister_hinweis":
        return a.siblingNote ?? "";
      case "zweitwunsch":
        return a.secondChoiceSchool ?? "";
      case "eltern1":
        return a.parent1Name;
      case "eltern2":
        return a.parent2Name ?? "";
      case "email2":
        return a.parent2Email ?? "";
      case "strasse":
        return a.addressStreet ?? "";
      case "plz":
        return a.addressZip ?? "";
      case "ort":
        return a.addressCity ?? "";
      case "telefon":
        return a.parent1Phone ?? "";
      case "email":
        return a.parent1Email;
      case "termin":
        return slot ? dtFmt.format(slot) : "";
      case "entschieden_am":
        return a.decidedAt ? dayFmt.format(a.decidedAt) : "";
    }
  };
  const header = columns.map((k) => EXPORT_COLUMNS.find((c) => c.key === k)!.label);
  const body = csvBytes([header, ...rows.map((r) => columns.map((k) => cell(r.a, r.slotStartsAt, k)))], encoding);
  await audit(db, viewer.userId, "anmeldung.export.svs", verfahrenId, { anzahl: rows.length, spalten: columns.length, kodierung: encoding, auswahl: scope });
  return { filename: `anmeldung-${fileSlug(v.name)}-${dayFmt.format(now).split(".").reverse().join("-")}.csv`, body, encoding, count: rows.length };
}

/**
 * Serienbrief-CSV für die Bescheide (Recht `anmeldung.manage` oder `anmeldung.decide`): je entschiedenem Antrag Anrede-
 * fähige Empfängerzeile, Anschrift, Kind, Vorgangsnummer und Entscheidung. Übernommene zählen als aufgenommen.
 */
export async function exportSerienbriefCsv(db: Db, viewer: PermissionSet, verfahrenId: string, encodingRaw: string, now = new Date()) {
  if (!canManage(viewer) && !canDecide(viewer)) throw new ForbiddenError("anmeldung.manage");
  const v = await loadVerfahrenName(db, verfahrenId);
  const encoding = (CSV_ENCODINGS as readonly string[]).includes(encodingRaw) ? (encodingRaw as CsvEncoding) : "utf8";
  const rows = await db
    .select()
    .from(anmeldungAntraege)
    // P4-78: kein Bescheid für Spam
    .where(and(eq(anmeldungAntraege.verfahrenId, verfahrenId), inArray(anmeldungAntraege.status, [...DECISION_STATUSES, "uebernommen"]), eq(anmeldungAntraege.rejectedAsSpam, false)))
    .orderBy(asc(anmeldungAntraege.status), de(anmeldungAntraege.childLastName), de(anmeldungAntraege.childFirstName));
  const label = (s: AntragStatus) => (s === "uebernommen" ? ANTRAG_STATUS_LABELS.aufgenommen : ANTRAG_STATUS_LABELS[s]);
  const body = csvBytes(
    [
      ["Vorgangsnummer", "Entscheidung", "Empfänger", "Elternteil 2", "Straße", "PLZ", "Ort", "Kind Vorname", "Kind Nachname", "Geburtsdatum", "Entschieden am"],
      ...rows.map((a) => [
        antragNumber(a.year, a.seq),
        label(a.status),
        a.parent1Name,
        a.parent2Name ?? "",
        a.addressStreet ?? "",
        a.addressZip ?? "",
        a.addressCity ?? "",
        a.childFirstName,
        a.childLastName,
        dmy(a.childBirthDate),
        a.decidedAt ? dayFmt.format(a.decidedAt) : "",
      ]),
    ],
    encoding,
  );
  await audit(db, viewer.userId, "anmeldung.export.serienbrief", verfahrenId, { anzahl: rows.length, kodierung: encoding });
  return { filename: `serienbrief-${fileSlug(v.name)}-${dayFmt.format(now).split(".").reverse().join("-")}.csv`, body, encoding, count: rows.length };
}
