// Datenschutzhinweise (Art. 13/14) und Verzeichnis der Verarbeitungstätigkeiten (Art. 30) aus den Manifesten (B-05).
// Jedes Modul beschreibt im Manifest seine Verarbeitung (`processing`), die Datenarten und Fristen kommen aus
// `retention`. Die Schule ergänzt Verantwortliche, Datenschutzbeauftragte, Betreiber und eigenen Text.
import { releaseNote } from "@/core/school/freigabe";
import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { appSettings } from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import type { ModuleManifest, ProcessingDecl } from "@/core/modules/types";
import { CORE_RETENTION, ruleText, type RetentionDecl } from "@/core/retention";
import { readPeriods } from "./fristen";
import { ValidationError } from "@/modules/verwaltung/users";
import { MODULES } from "@/modules";

/**
 * Rechtsgrundlage für die Verarbeitung im Schulverhältnis – **Vorlage nur für NRW** (2026-10-04, abgeglichen mit dem Wortlaut
 * von §§ 8, 120, 121 SchulG NRW und VO-DV I; DATENSCHUTZ.md §2). § 120 Abs. 5 / § 121 Abs. 1 i. V. m. § 8 Abs. 2
 * erlauben ausdrücklich Lehr- und Lernsysteme sowie Arbeits- und Kommunikationsplattformen. § 122 Abs. 1 Satz 2 stellt klar,
 * dass §§ 120, 121 auf Art. 6 Abs. 1 lit. e, Abs. 3 und Art. 9 Abs. 2 lit. g DSGVO beruhen (DS-17, B05-KRANKMELDUNG.md) –
 * genannt wird er bei Modulen mit eigener Grundlage (Abwesenheiten, Klassenbuch). Eine eigene „Anlage zu digitalen Systemen“
 * hat die VO-DV I nicht (nur Anlagen 1–3); für Plattformen gelten § 120 Abs. 5 SchulG und § 2 VO-DV I.
 */
export const LEGAL_BASIS_SCHOOL =
  "Art. 6 Abs. 1 lit. e, Abs. 3 DSGVO i. V. m. § 120 Abs. 1 und 5, § 121 Abs. 1, § 8 Abs. 2 SchulG NRW sowie VO-DV I und VO-DV II";

/** DS-14: Kennzeichnung der erzeugten Datenschutzhinweise und des VVT als Vorlage (sachlich, ohne Zusagen). */
export const TEMPLATE_LABEL = "Vorlage – von der Schule zu prüfen und anzupassen";
export const TEMPLATE_NOTE =
  "SchulOS erzeugt diesen Text aus den eingeschalteten Modulen (Zwecke, Rechtsgrundlagen, Datenarten, Löschfristen). Verantwortliche nach DSGVO ist die Schule: Sie prüft die Angaben mit ihrer bzw. ihrem Datenschutzbeauftragten und ergänzt oder ändert sie. SchulOS stellt die Vorlage ohne Gewähr bereit (AGPL-3.0, §§ 15–16).";

/** Warnhinweis, wenn die Schule nicht in NRW liegt: für andere Länder gibt es keine ausgearbeitete Vorlage. */
export function legalBasisWarning(state: string): string | null {
  return releaseNote(state);
}

/** Grundsystem: Konten, Gruppen, Rechte, Benachrichtigungen, Protokoll. */
export const CORE_PROCESSING: ProcessingDecl = {
  title: "Benutzerkonten, Gruppen und Rechte",
  purpose: "Zugang zur Plattform, Zuordnung zu Klassen, Kursen und Gruppen, Rechteverwaltung, Benachrichtigungen und Nachweis von Änderungen",
  subjects: ["Schüler:innen", "Eltern", "Lehrkräfte", "Verwaltungspersonal"],
  recipients: ["Verwaltung und Schulleitung (Benutzerverwaltung)", "Administration (technische Betreuung)"],
};

export interface DataType {
  purpose: string;
  scope?: string;
  categories: string[];
  /** Speicherdauer in Worten */
  retention: string;
}

export interface ProcessingRecord {
  id: string;
  title: string;
  purpose: string;
  legalBasis: string;
  subjects: string[];
  recipients: string[];
  dataTypes: DataType[];
  note?: string;
}

type Periods = ReadonlyMap<string, number>;

function retentionText(decl: RetentionDecl, all: readonly RetentionDecl[], periods: Periods): string {
  if ("follows" in decl) {
    const parent = all.find((d) => d.table === decl.follows && !("follows" in d));
    return parent && !("follows" in parent) ? retentionText(parent, all, periods) : "zusammen mit dem zugehörigen Datensatz";
  }
  // DS-15: eine von der Schule eingestellte Frist ersetzt die Regelfrist der Klasse
  const rule = ruleText(decl.class, decl.period ? periods.get(decl.period) : null);
  return decl.note ? `${rule} (${decl.note})` : rule;
}

function record(id: string, p: ProcessingDecl, retention: readonly RetentionDecl[], periods: Periods): ProcessingRecord {
  return {
    id,
    title: p.title,
    purpose: p.purpose,
    legalBasis: p.legalBasis ?? LEGAL_BASIS_SCHOOL,
    subjects: p.subjects,
    recipients: p.recipients,
    note: p.note,
    dataTypes: retention.map((d) => ({ purpose: d.purpose, scope: d.scope, categories: d.categories, retention: retentionText(d, retention, periods) })),
  };
}

/** Verarbeitungstätigkeiten der aktiven Module (Grundsystem zuerst). */
export function processingRecords(modules: readonly ModuleManifest[], periods: Periods = new Map()): ProcessingRecord[] {
  return [
    record("core", CORE_PROCESSING, CORE_RETENTION, periods),
    ...modules.filter((m) => m.processing).map((m) => record(m.id, m.processing!, m.retention ?? [], periods)),
  ];
}

export async function activeProcessingRecords(db: Db): Promise<ProcessingRecord[]> {
  const [states, periods] = await Promise.all([loadModuleStates(db), readPeriods(db)]);
  return processingRecords(
    MODULES.filter((m) => isEnabled(m, states)),
    periods,
  );
}

// ---------------------------------------------------------------- Angaben der Schule

export const PRIVACY_TEXT_FIELDS = {
  controller: { label: "Verantwortliche Stelle", hint: "Name und Anschrift der Schule, vertreten durch die Schulleitung", max: 600 },
  dpo: { label: "Datenschutzbeauftragte:r", hint: "Name bzw. Funktion und Kontakt (E-Mail, Telefon)", max: 400 },
  operator: { label: "Betrieb der Plattform", hint: "Wer den Server betreibt (Schule, Schulträger, Dienstleister als Auftragsverarbeiter)", max: 600 },
  authority: { label: "Aufsichtsbehörde", hint: "für Beschwerden nach Art. 77 DSGVO", max: 400 },
  extra: { label: "Ergänzungen der Schule", hint: "eigener Text, erscheint am Ende der Datenschutzhinweise", max: 4000 },
} as const;
export type PrivacyTextKey = keyof typeof PRIVACY_TEXT_FIELDS;
export type PrivacyTexts = Record<PrivacyTextKey, string>;

const DEFAULT_TEXTS: PrivacyTexts = {
  controller: "",
  dpo: "",
  operator: "",
  authority: "Landesbeauftragte für Datenschutz und Informationsfreiheit Nordrhein-Westfalen, Kavalleriestraße 2–4, 40213 Düsseldorf",
  extra: "",
};

const key = (k: PrivacyTextKey) => `privacy.${k}`;

export async function readPrivacyTexts(db: Db): Promise<PrivacyTexts> {
  const keys = Object.keys(PRIVACY_TEXT_FIELDS) as PrivacyTextKey[];
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, keys.map(key)));
  const out = { ...DEFAULT_TEXTS };
  for (const k of keys) {
    const v = rows.find((r) => r.key === key(k))?.value;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export async function savePrivacyTexts(db: Db, actorId: string, input: Partial<Record<PrivacyTextKey, string>>): Promise<void> {
  const fe: Record<string, string> = {};
  const clean: Partial<PrivacyTexts> = {};
  for (const [k, f] of Object.entries(PRIVACY_TEXT_FIELDS) as [PrivacyTextKey, (typeof PRIVACY_TEXT_FIELDS)[PrivacyTextKey]][]) {
    const v = (input[k] ?? "").replace(/\r\n/g, "\n").trim();
    if (v.length > f.max) fe[k] = `höchstens ${f.max} Zeichen`;
    clean[k] = v;
  }
  if (Object.keys(fe).length) throw new ValidationError(fe);
  for (const [k, v] of Object.entries(clean) as [PrivacyTextKey, string][])
    await db
      .insert(appSettings)
      .values({ key: key(k), value: v })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: v, updatedAt: new Date() } });
  await audit(db, actorId, "datenschutz.hinweise", null, {});
}

/** Was vor dem Echtbetrieb noch fehlt (für Hinweise in der Verwaltung). */
export function missingTexts(t: PrivacyTexts): PrivacyTextKey[] {
  return (["controller", "dpo", "operator"] as const).filter((k) => !t[k].trim());
}
