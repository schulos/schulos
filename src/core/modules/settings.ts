// Moduleinstellungen (Q5-14, I-60): Schalter je Modul, im Manifest unter `settings` deklariert, gepflegt unter
// Verwaltung → Rechte & Module, gespeichert in app_settings (`module.<schlüssel>`). Einstellungen haben keinen
// Personenbezug; Änderungen werden protokolliert (`verwaltung.module.setting`).
import { eq, like } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { appSettings } from "@/core/db/schema";
import { daysText } from "@/core/retention";

export interface ModuleSettingOption {
  value: string;
  label: string;
}

export interface ModuleSettingDecl {
  /** "<modul-id>.<name>", z. B. "messenger.student_direct" */
  key: string;
  label: string;
  /** Erklärung in einem Satz (erscheint unter der Auswahl) */
  help?: string;
  options: readonly ModuleSettingOption[];
  /** Vorgabe, solange nichts gespeichert ist – muss einer der Optionen entsprechen */
  default: string;
  /**
   * DS-15: zusätzlich nötiges Recht zum Ändern (neben `verwaltung.rights`), z. B. `verwaltung.privacy` für Löschfristen –
   * im Service geprüft (`setModuleSetting`).
   */
  permission?: string;
  /** Q-5A-1: nach dem Ändern ausführen (z. B. abgeleitete Werte neu berechnen) – nur bei tatsächlicher Änderung */
  onChange?: (db: Db) => Promise<void>;
}

export function defineSetting<const T extends ModuleSettingDecl>(decl: T): T {
  return decl;
}

const storageKey = (key: string) => `module.${key}`;

/** Optionen „aus“ + „bis Jahrgang n“ für Schalter, die nach Jahrgängen abgestuft sind. */
export function gradeOptions(from: number, to: number, offLabel = "aus"): ModuleSettingOption[] {
  const out: ModuleSettingOption[] = [{ value: "0", label: offLabel }];
  for (let g = from; g <= to; g++) out.push({ value: String(g), label: `bis Jahrgang ${g}` });
  return out;
}

/**
 * DS-15: Optionen für eine Frist in Tagen (Löschkonzept `period`), Beschriftung „90 Tage“, „1 Jahr“ …; die Vorgabe trägt
 * den Zusatz „(Vorgabe)“. Grenzen prüft `retention.test.ts` gegen die Löschklasse.
 */
export function dayOptions(days: readonly number[], defaultDays: number): ModuleSettingOption[] {
  return days.map((d) => ({ value: String(d), label: `${daysText(d)}${d === defaultDays ? " (Vorgabe)" : ""}` }));
}

function coerce(decl: ModuleSettingDecl, raw: unknown): string {
  const v = typeof raw === "string" || typeof raw === "number" ? String(raw) : undefined;
  return v !== undefined && decl.options.some((o) => o.value === v) ? v : decl.default;
}

/** Aktueller Wert einer Einstellung (frisch gelesen); unbekannte/ungültige Werte fallen auf die Vorgabe zurück. */
export async function readModuleSetting(db: Db, decl: ModuleSettingDecl): Promise<string> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, storageKey(decl.key)));
  return coerce(decl, row?.value);
}

/** Jahrgangs-Schalter als Zahl (0 = aus). */
export async function readGradeSetting(db: Db, decl: ModuleSettingDecl): Promise<number> {
  return Number(await readModuleSetting(db, decl)) || 0;
}

/** Alle Werte für die übergebenen Deklarationen in einer Abfrage (Verwaltungsseite). */
export async function readModuleSettings(db: Db, decls: readonly ModuleSettingDecl[]): Promise<Map<string, string>> {
  const rows = await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).where(like(appSettings.key, "module.%"));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return new Map(decls.map((d) => [d.key, coerce(d, stored.get(storageKey(d.key)))]));
}

/** Speichert eine Einstellung; wirft bei unbekanntem Wert. Rechteprüfung und Audit macht der Aufrufer. */
export async function writeModuleSetting(db: Db, decl: ModuleSettingDecl, value: string): Promise<void> {
  if (!decl.options.some((o) => o.value === value)) throw new Error(`Ungültiger Wert für ${decl.key}: ${value}`);
  await db
    .insert(appSettings)
    .values({ key: storageKey(decl.key), value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}
