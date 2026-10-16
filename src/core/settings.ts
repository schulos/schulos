import { inArray } from "drizzle-orm";
import { cache } from "react";
import type { Db } from "@/core/db/client";
import { getDb } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { isSchoolForm, isStateCode, type SchoolProfile } from "@/core/school/catalog";
import { LOGO_SETTING_KEYS, LOGO_VARIANTS, parseLogoMeta, type SchoolLogos } from "@/core/school/logo-meta";

export interface SchoolSettings {
  name: string;
  color: string;
  /** amtliche Schulnummer (optional) */
  number: string;
  profile: SchoolProfile;
  logos: SchoolLogos;
}

const DEFAULT_PROFILE: SchoolProfile = { state: "NW", form: "gesamtschule", oberstufe: true, abitur: "g9" };
const DEFAULTS = { name: "SchulOS", color: "#0E7C66" };
const KEYS = ["school.name", "school.color", "school.number", "school.state", "school.form", "school.oberstufe", "school.abitur", ...Object.values(LOGO_SETTING_KEYS)];
const DEMO_KEY = "demo";

/**
 * SEC-01/P4-71: Anmelde-Einstellungen der Schule (Verwaltung → System → Anmeldung). `twoFactorFrom`: Stichtag der 2FA-Pflicht
 * für Lehrkräfte, Personal und Eltern (YYYY-MM-DD; Migration 0078 setzt ihn beim Update auf heute + 28 Tage); `schoolNets`:
 * Schulnetz-Bereiche als Text (null = Vorgabe); `idleMinutes`: Inaktivitätsablauf der Sitzung (0 = aus).
 */
export interface SecuritySettings {
  twoFactorFrom: string | null;
  schoolNets: string | null;
  idleMinutes: number;
}

export const SECURITY_KEYS = { twoFactorFrom: "sicherheit.zwei_faktor_ab", schoolNets: "sicherheit.schulnetz", idleMinutes: "sicherheit.inaktiv_minuten" } as const;

function toSecuritySettings(rows: { key: string; value: unknown }[]): SecuritySettings {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const from = get(SECURITY_KEYS.twoFactorFrom);
  const nets = get(SECURITY_KEYS.schoolNets);
  const idle = Number(get(SECURITY_KEYS.idleMinutes));
  return {
    twoFactorFrom: typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null,
    schoolNets: typeof nets === "string" && nets.trim() ? nets : null,
    idleMinutes: Number.isInteger(idle) && idle > 0 ? idle : 0,
  };
}

/** Anmelde-Einstellungen frisch gelesen (zum Ändern, in Tests und Hintergrundjobs). */
export async function readSecuritySettings(db: Db): Promise<SecuritySettings> {
  return toSecuritySettings(await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(inArray(appSettings.key, Object.values(SECURITY_KEYS))));
}

/** Schuldaten aus app_settings, frisch gelesen (für Änderungen und Hintergrundjobs); fehlende Werte fallen auf Vorgaben zurück. */
export async function readSchoolSettings(db: Db): Promise<SchoolSettings> {
  return toSchoolSettings(await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(inArray(appSettings.key, KEYS)));
}

/**
 * Schuldaten und Demo-Kennzeichen in **einer** Abfrage, pro Request und Datenbank gecacht (B-56 – vorher bis zu sechs
 * app_settings-Abfragen je Seite). Nur zum Lesen beim Rendern; wer Einstellungen ändert, liest mit readSchoolSettings frisch.
 */
const requestSettings = cache(async (db: Db) => {
  const rows = await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(inArray(appSettings.key, [...KEYS, DEMO_KEY, ...Object.values(SECURITY_KEYS)]));
  return { school: toSchoolSettings(rows), demo: rows.find((r) => r.key === DEMO_KEY)?.value === true, security: toSecuritySettings(rows) };
});

/** Anmelde-Einstellungen, pro Request gecacht (Rechteprüfung je Anfrage). */
export async function cachedSecuritySettings(db: Db): Promise<SecuritySettings> {
  return (await requestSettings(db)).security;
}

/** Wie readSchoolSettings, aber pro Request gecacht. */
export async function cachedSchoolSettings(db: Db): Promise<SchoolSettings> {
  return (await requestSettings(db)).school;
}

/** Datenbank ist als Demo markiert (app_settings.demo = true, setzt der Seed) – pro Request gecacht. */
export async function isDemoDb(db: Db): Promise<boolean> {
  return (await requestSettings(db)).demo;
}

function toSchoolSettings(rows: { key: string; value: unknown }[]): SchoolSettings {
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const color = get("school.color");
  const name = get("school.name");
  const number = get("school.number");
  const state = get("school.state");
  const form = get("school.form");
  const oberstufe = get("school.oberstufe");
  const abitur = get("school.abitur");
  return {
    name: typeof name === "string" ? name : DEFAULTS.name,
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULTS.color,
    // jsonb liefert rein numerische Werte („4711“) als Zahl zurück
    number: typeof number === "string" || typeof number === "number" ? String(number) : "",
    profile: {
      state: isStateCode(state) ? state : DEFAULT_PROFILE.state,
      form: isSchoolForm(form) ? form : DEFAULT_PROFILE.form,
      oberstufe: typeof oberstufe === "boolean" ? oberstufe : DEFAULT_PROFILE.oberstufe,
      abitur: abitur === "g8" ? "g8" : "g9",
    },
    logos: Object.fromEntries(LOGO_VARIANTS.map((v) => [v, parseLogoMeta(get(LOGO_SETTING_KEYS[v]))] as const).filter(([, m]) => m !== null)),
  };
}

/** Schulname, Farbe, Profil und Logos, pro Request gecacht. */
export const getSchoolSettings = cache(async (): Promise<SchoolSettings> => cachedSchoolSettings(await getDb()));
