// Datenschutz-Einrichtung durch die Schule (DS-12). Die Schule ist Verantwortliche und entscheidet; SchulOS liefert die
// Vorgaben (Manifeste) und dieses Werkzeug: (1) Bestätigung „Verantwortliche nach Art. 4 Nr. 7 DSGVO, DSB benannt“,
// (2) je Thema der DSB-Checkliste (DS-13, src/core/privacy/checkliste.ts) ein Status mit Bemerkung samt den zugehörigen
// Moduleinstellungen und allen Löschfristen, (3) Nachweis als Druck bzw. JSON. Gespeichert in app_settings (`privacy.setup.*`,
// ohne Personenbezug – wer etwas geändert hat, steht nur im Audit-Log `datenschutz.einrichtung.*`).
//
// Ein Thema gilt als erledigt, wenn es einen Status hat **und** seine Einstellungen seitdem nicht geändert wurden (sonst
// „seit der Prüfung geändert“ → wieder offen). Neue Themen nach einem Update sind ebenfalls offen. Solange etwas offen ist,
// zeigt Heute (Offen für dich) allen mit `verwaltung.privacy` einen Hinweis.
import { inArray, like } from "drizzle-orm";
import { audit } from "@/core/audit";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { isEnabled, loadModuleStates } from "@/core/modules/registry";
import { readModuleSettings, type ModuleSettingDecl } from "@/core/modules/settings";
import { collectRetention, RETENTION_CLASSES, ruleText } from "@/core/retention";
import { ValidationError } from "@/modules/verwaltung/users";
import { MODULES } from "@/modules";
import { DSB_TOPICS, type DsbTopic } from "./checkliste";
import { readPeriods } from "./fristen";
import { missingTexts, readPrivacyTexts } from "./hinweise";

export const SETUP_STATUSES = {
  vorgabe: "Vorgabe übernommen",
  geaendert: "geändert",
  dsb: "mit DSB geklärt",
} as const;
export type SetupStatus = keyof typeof SETUP_STATUSES;

export const NOTE_MAX = 500;
const CONFIRM_KEY = "privacy.setup.confirm";
const topicKey = (id: string) => `privacy.setup.topic.${id}`;

/** Text der Bestätigung (Schritt 1) – so steht er auch im Nachweis. */
export const CONFIRM_TEXT =
  "Die Schule ist Verantwortliche nach Art. 4 Nr. 7 DSGVO für die Verarbeitung in SchulOS und hat eine Datenschutzbeauftragte bzw. einen Datenschutzbeauftragten benannt (Name und Kontakt unter „Hinweise und VVT“).";

interface StoredTopic {
  status: SetupStatus;
  note: string;
  at: string;
  /** Werte der Einstellungen des Themas zum Zeitpunkt der Prüfung */
  values: Record<string, string>;
}
interface StoredConfirm {
  at: string;
  dpo: string;
}

export interface SetupSetting {
  key: string;
  moduleId: string;
  moduleName: string;
  moduleEnabled: boolean;
  label: string;
  value: string;
  valueLabel: string;
  defaultValue: string;
  defaultLabel: string;
  changed: boolean;
}

export interface SetupTopic extends DsbTopic {
  settingsState: SetupSetting[];
  status: SetupStatus | null;
  note: string;
  checkedAt: string | null;
  /** Status vorhanden, aber eine Einstellung des Themas wurde danach geändert */
  stale: boolean;
  done: boolean;
}

export interface SetupRetention {
  owner: string;
  ownerName: string;
  table: string;
  scope?: string;
  purpose: string;
  categories: string[];
  classId: string | null;
  rule: string;
  /** Moduleinstellung, über die die Schule die Frist ändern kann (DS-15) */
  setting?: string;
}

export interface SetupState {
  confirmed: boolean;
  confirmedAt: string | null;
  /** DSB-Angabe zum Zeitpunkt der Bestätigung */
  confirmedDpo: string | null;
  /** fehlende Angaben der Schule (Verantwortliche Stelle, DSB, Betrieb) */
  missingTexts: string[];
  topics: SetupTopic[];
  retention: SetupRetention[];
  open: number;
  done: boolean;
}

function allSettings(): { decl: ModuleSettingDecl; moduleId: string; moduleName: string }[] {
  return MODULES.flatMap((m) => (m.settings ?? []).map((decl) => ({ decl, moduleId: m.id, moduleName: m.name })));
}

const isStatus = (v: unknown): v is SetupStatus => typeof v === "string" && v in SETUP_STATUSES;

function parseTopic(v: unknown): StoredTopic | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<StoredTopic>;
  if (!isStatus(o.status) || typeof o.at !== "string") return null;
  return { status: o.status, note: typeof o.note === "string" ? o.note : "", at: o.at, values: o.values && typeof o.values === "object" ? o.values : {} };
}

/** Gesamtstand der Einrichtung (frisch gelesen). */
export async function readSetup(db: Db): Promise<SetupState> {
  const settings = allSettings();
  const [rows, values, states, periods, texts] = await Promise.all([
    db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(like(appSettings.key, "privacy.setup.%")),
    readModuleSettings(
      db,
      settings.map((s) => s.decl),
    ),
    loadModuleStates(db),
    readPeriods(db),
    readPrivacyTexts(db),
  ]);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const confirm = stored.get(CONFIRM_KEY) as Partial<StoredConfirm> | undefined;
  const settingState = (key: string): SetupSetting | null => {
    const s = settings.find((x) => x.decl.key === key);
    if (!s) return null;
    const value = values.get(key) ?? s.decl.default;
    const label = (v: string) => s.decl.options.find((o) => o.value === v)?.label ?? v;
    const m = MODULES.find((x) => x.id === s.moduleId)!;
    return {
      key,
      moduleId: s.moduleId,
      moduleName: s.moduleName,
      moduleEnabled: isEnabled(m, states),
      label: s.decl.label,
      value,
      valueLabel: label(value),
      defaultValue: s.decl.default,
      defaultLabel: label(s.decl.default),
      changed: value !== s.decl.default,
    };
  };
  const topics: SetupTopic[] = DSB_TOPICS.map((t) => {
    const st = parseTopic(stored.get(topicKey(t.id)));
    const settingsState = (t.settings ?? []).map(settingState).filter((x): x is SetupSetting => Boolean(x));
    const stale = Boolean(st && settingsState.some((s) => st.values[s.key] !== s.value));
    return { ...t, settingsState, status: st?.status ?? null, note: st?.note ?? "", checkedAt: st?.at ?? null, stale, done: Boolean(st) && !stale };
  });
  const ownerName = (o: string) => (o === "core" ? "Grundsystem" : (MODULES.find((m) => m.id === o)?.name ?? o));
  const retention: SetupRetention[] = collectRetention(MODULES).map(({ owner, decl }) => ({
    owner,
    ownerName: ownerName(owner),
    table: decl.table,
    scope: decl.scope,
    purpose: decl.purpose,
    categories: decl.categories,
    classId: "follows" in decl ? null : decl.class,
    rule: "follows" in decl ? `mit „${decl.follows}“` : ruleText(decl.class, decl.period ? periods.get(decl.period) : null),
    ...("class" in decl && decl.period ? { setting: decl.period } : {}),
  }));
  const confirmed = typeof confirm?.at === "string";
  const open = topics.filter((t) => !t.done).length + (confirmed ? 0 : 1);
  return {
    confirmed,
    confirmedAt: confirmed ? confirm!.at! : null,
    confirmedDpo: confirmed && typeof confirm!.dpo === "string" ? confirm!.dpo : null,
    missingTexts: missingTexts(texts),
    topics,
    retention,
    open,
    done: open === 0,
  };
}

/** Schritt 1: Bestätigung – nur mit Angaben zu Verantwortlicher Stelle und DSB (Hinweise und VVT). */
export async function confirmResponsibility(db: Db, actorId: string, accepted: boolean, now = new Date()): Promise<void> {
  if (!accepted) throw new ValidationError({ confirm: "Bitte die Bestätigung ankreuzen" });
  const texts = await readPrivacyTexts(db);
  const missing = missingTexts(texts).filter((k) => k === "controller" || k === "dpo");
  if (missing.length) throw new ValidationError({ confirm: "Erst Verantwortliche Stelle und Datenschutzbeauftragte:n unter „Hinweise und VVT“ eintragen" });
  const value: StoredConfirm = { at: now.toISOString(), dpo: texts.dpo };
  await db.insert(appSettings).values({ key: CONFIRM_KEY, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  await audit(db, actorId, "datenschutz.einrichtung.bestaetigt", null, {});
}

/** Bestätigung zurücknehmen (z. B. neue DSB) – danach ist die Einrichtung wieder offen. */
export async function revokeConfirmation(db: Db, actorId: string): Promise<void> {
  await db.delete(appSettings).where(inArray(appSettings.key, [CONFIRM_KEY]));
  await audit(db, actorId, "datenschutz.einrichtung.bestaetigung_zurueck", null, {});
}

/** Schritt 2: Status eines Themas setzen (oder mit `null` zurücksetzen); merkt sich die aktuellen Werte seiner Einstellungen. */
export async function setTopicStatus(db: Db, actorId: string, topicId: string, status: SetupStatus | null, note: string, now = new Date()): Promise<void> {
  const topic = DSB_TOPICS.find((t) => t.id === topicId);
  if (!topic) throw new ValidationError({ topic: "Unbekannter Punkt" });
  if (status !== null && !isStatus(status)) throw new ValidationError({ status: "Status wählen" });
  const clean = note.replace(/\r\n/g, "\n").trim();
  if (clean.length > NOTE_MAX) throw new ValidationError({ note: `höchstens ${NOTE_MAX} Zeichen` });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) throw new ValidationError({ note: "Steuerzeichen sind nicht erlaubt" });
  if (status === null) {
    await db.delete(appSettings).where(inArray(appSettings.key, [topicKey(topicId)]));
    await audit(db, actorId, "datenschutz.einrichtung.punkt", topicId, { status: null });
    return;
  }
  const decls = allSettings()
    .map((s) => s.decl)
    .filter((d) => topic.settings?.includes(d.key));
  const values = Object.fromEntries(await readModuleSettings(db, decls));
  const value: StoredTopic = { status, note: clean, at: now.toISOString(), values };
  await db.insert(appSettings).values({ key: topicKey(topicId), value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  await audit(db, actorId, "datenschutz.einrichtung.punkt", topicId, { status, values });
}

/** Schritt 3: Nachweis als JSON („Datenschutz-Konfiguration Stand …“) – enthält alle Themen, Einstellungen und Löschfristen. */
export async function setupExport(db: Db, actorId: string, school: string, now = new Date()) {
  const s = await readSetup(db);
  await audit(db, actorId, "datenschutz.einrichtung.export", null, {});
  return {
    titel: `Datenschutz-Konfiguration ${school}`,
    stand: now.toISOString(),
    hinweis: "Nachweis aus SchulOS für die Datenschutzbeauftragte bzw. den Datenschutzbeauftragten der Schule – Vorgaben ohne Gewähr, von der Schule zu prüfen.",
    bestaetigung: { text: CONFIRM_TEXT, bestaetigt: s.confirmed, am: s.confirmedAt, dsb: s.confirmedDpo },
    erledigt: s.done,
    offen: s.open,
    themen: s.topics.map((t) => ({
      nr: t.nr,
      id: t.id,
      titel: t.title,
      was_schulos_tut: t.schulos,
      vorgabe: t.vorgabe,
      die_schule_entscheidet: t.schule,
      status: t.status ? SETUP_STATUSES[t.status] : "offen",
      seit_pruefung_geaendert: t.stale,
      geprueft_am: t.checkedAt,
      bemerkung: t.note,
      einstellungen: t.settingsState.map((x) => ({ schluessel: x.key, modul: x.moduleName, modul_an: x.moduleEnabled, name: x.label, wert: x.valueLabel, vorgabe: x.defaultLabel, geaendert: x.changed })),
    })),
    loeschfristen: s.retention.map((r) => ({
      bereich: r.ownerName,
      tabelle: r.table,
      teilmenge: r.scope ?? null,
      zweck: r.purpose,
      datenkategorien: r.categories,
      loeschklasse: r.classId,
      loeschklasse_text: r.classId ? RETENTION_CLASSES[r.classId as keyof typeof RETENTION_CLASSES].label : null,
      frist: r.rule,
      einstellbar_ueber: r.setting ?? null,
    })),
  };
}
