// DS-15: von der Schule eingestellte Löschfristen (Moduleinstellungen mit `period` im Löschkonzept). Der Löschlauf, die
// Übersicht Löschkonzept, Datenschutzhinweise/VVT und die Datenschutz-Einrichtung (DS-12) lesen die Werte hier – jeweils
// frisch und nur innerhalb der Grenzen der Löschklasse (sonst gilt die Regelfrist).
import type { Db } from "@/core/db/client";
import { readModuleSettings, type ModuleSettingDecl } from "@/core/modules/settings";
import { CLASS_DAYS, collectRetention, PERIOD_MIN_DAYS, type RetentionClassId, type RetentionDecl, type RetentionEntry } from "@/core/retention";
import { MODULES } from "@/modules";

/** Deklaration der Moduleinstellung zu einem `period`-Schlüssel. */
export function periodSetting(key: string): ModuleSettingDecl | undefined {
  return MODULES.flatMap((m) => m.settings ?? []).find((s) => s.key === key);
}

/** Rein: gültige Frist in Tagen für diese Klasse – sonst null (dann gilt die Regelfrist). */
export function validPeriod(classId: RetentionClassId, raw: string | undefined | null): number | null {
  const bounds = CLASS_DAYS[classId];
  if (!bounds || !raw || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= PERIOD_MIN_DAYS && n <= bounds.max ? n : null;
}

/** Alle wirksamen Fristen: Einstellungsschlüssel → Tage (nur gültige Werte; fehlt ein Schlüssel, gilt die Regelfrist). */
export async function readPeriods(db: Db, entries: readonly RetentionEntry[] = collectRetention(MODULES)): Promise<Map<string, number>> {
  const withPeriod = entries.map((e) => e.decl).filter((d): d is RetentionDecl & { class: RetentionClassId; period: string } => "class" in d && Boolean(d.period));
  const decls = [...new Set(withPeriod.map((d) => d.period))].map(periodSetting).filter((d): d is ModuleSettingDecl => Boolean(d));
  const values = await readModuleSettings(db, decls);
  const out = new Map<string, number>();
  for (const d of withPeriod) {
    const v = validPeriod(d.class, values.get(d.period));
    if (v) out.set(d.period, v);
  }
  return out;
}

/** Frist einer Deklaration in Tagen (eingestellt oder Regelfrist); null bei Klassen ohne Tagesfrist. */
export function periodFor(decl: RetentionDecl, periods: ReadonlyMap<string, number>): number | null {
  if ("follows" in decl) return null;
  return (decl.period ? periods.get(decl.period) : undefined) ?? CLASS_DAYS[decl.class]?.rule ?? null;
}
