// Schullogo (P4-02/P4-03): hochladen, ersetzen, entfernen; Auslieferung über GET /api/schule/logo.
// Metadaten in app_settings (school.logo, school.logo_dark, school.symbol), Dateien im Dateispeicher (im Backup).
// Kein Personenbezug → keine Löschklasse. SVG nur nach dem Annahmefilter (images-svg.ts), Rasterbilder ohne Metadaten.
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { audit } from "@/core/audit";
import { appSettings } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { cleanImage, sniffImage, type ImageMime, type ImageSize } from "@/core/images";
import { checkSvg, looksLikeSvg } from "@/core/images-svg";
import { registerStorageKeySource } from "@/core/privacy/dateispeicher";
import { LOGO_SETTING_KEYS, LOGO_VARIANTS, parseLogoMeta, type LogoMeta, type LogoVariant } from "@/core/school/logo-meta";
import { ValidationError } from "@/modules/verwaltung/users";

export const LOGO_MAX_BYTES: Record<LogoVariant, number> = { logo: 1024 * 1024, dark: 1024 * 1024, symbol: 512 * 1024 };
/** Symbol: annähernd quadratisch (Favicon, Monitor-Ecke) – höchstens 3 : 2 */
const SYMBOL_MAX_RATIO = 1.5;

export const LOGO_LABEL: Record<LogoVariant, string> = { logo: "Logo", dark: "Logo für dunkle Darstellung", symbol: "Symbol" };

const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${n / (1024 * 1024)} MB` : `${n / 1024} KB`);

/** Rein: prüft eine hochgeladene Logo-Datei und bereitet sie zum Speichern vor (Meldungen am Feld `variant`). */
export function prepareLogo(bytes: Uint8Array, variant: LogoVariant): { data: Uint8Array; mime: ImageMime; size: ImageSize } {
  const max = LOGO_MAX_BYTES[variant];
  const fail = (msg: string): never => {
    throw new ValidationError({ [variant]: msg });
  };
  if (!bytes.length) fail("Bitte eine Bilddatei auswählen.");
  if (bytes.length > max) fail(`Die Datei ist zu groß (höchstens ${sizeLabel(max)}).`);
  let out: { data: Uint8Array; mime: ImageMime; size: ImageSize | null };
  if (sniffImage(bytes)) {
    out = cleanImage(bytes, {
      field: variant,
      maxBytes: max,
      types: ["image/png", "image/jpeg", "image/webp"],
      empty: "Bitte eine Bilddatei auswählen.",
      tooBig: `Die Datei ist zu groß (höchstens ${sizeLabel(max)}).`,
      wrongType: "Bitte ein Bild als PNG, JPEG, WebP oder SVG hochladen.",
    });
  } else if (looksLikeSvg(bytes)) {
    const r = checkSvg(bytes);
    if (!r.ok) return fail(`Diese SVG-Datei wird aus Sicherheitsgründen nicht angenommen: Sie ${r.reason}. Tipp: als PNG exportieren.`);
    out = { data: bytes, mime: "image/svg+xml", size: r.size };
  } else {
    return fail("Bitte ein Bild als PNG, JPEG, WebP oder SVG hochladen.");
  }
  if (!out.size) return fail("Die Bildgröße lässt sich nicht lesen – bitte die Datei neu exportieren.");
  const { width, height } = out.size;
  if (variant === "symbol" && Math.max(width, height) / Math.min(width, height) > SYMBOL_MAX_RATIO)
    fail("Das Symbol sollte (fast) quadratisch sein – für breite Logos das Feld „Logo“ nutzen.");
  return { data: out.data, mime: out.mime, size: out.size };
}

/** Gespeicherte Logo-Angaben, frisch gelesen (Route, Änderungen). */
export async function readLogos(db: Db): Promise<Partial<Record<LogoVariant, LogoMeta>>> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(LOGO_SETTING_KEYS)));
  const out: Partial<Record<LogoVariant, LogoMeta>> = {};
  for (const v of LOGO_VARIANTS) {
    const meta = parseLogoMeta(rows.find((r) => r.key === LOGO_SETTING_KEYS[v])?.value);
    if (meta) out[v] = meta;
  }
  return out;
}

/** Dateischlüssel aller Logos – der nächtliche Aufräumlauf darf sie nicht löschen (dateispeicher.ts). */
export async function logoStorageKeys(db: Db): Promise<string[]> {
  return Object.values(await readLogos(db)).map((m) => m.key);
}
registerStorageKeySource(logoStorageKeys);

const hashOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

async function writeSetting(db: Db, key: string, value: unknown) {
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/** Logo-Variante setzen bzw. ersetzen; die alte Datei wird gelöscht. Rechte prüft die Server Action. */
export async function setSchoolLogo(db: Db, storage: FileStorage, actorId: string | null, variant: LogoVariant, bytes: Uint8Array): Promise<LogoMeta> {
  const { data, mime, size } = prepareLogo(bytes, variant);
  const meta: LogoMeta = { key: newStorageKey(), mime, width: size.width, height: size.height, bytes: data.length, hash: hashOf(data) };
  await storage.put(meta.key, data);
  const old = (await readLogos(db))[variant];
  await writeSetting(db, LOGO_SETTING_KEYS[variant], meta);
  if (old && old.key !== meta.key) await storage.delete(old.key);
  if (actorId !== null) await audit(db, actorId, "verwaltung.school.logo", variant, { action: old ? "replace" : "set", mime, width: size.width, height: size.height });
  return meta;
}

/** Logo-Variante entfernen (Einstellung und Datei). */
export async function removeSchoolLogo(db: Db, storage: FileStorage, actorId: string, variant: LogoVariant): Promise<boolean> {
  const old = (await readLogos(db))[variant];
  if (!old) return false;
  await db.delete(appSettings).where(inArray(appSettings.key, [LOGO_SETTING_KEYS[variant]]));
  await storage.delete(old.key);
  await audit(db, actorId, "verwaltung.school.logo", variant, { action: "remove" });
  return true;
}

/** Rein: Wert von `?variante=` → Variante; unbekannt → null. */
export function parseLogoVariant(v: string | null): LogoVariant | null {
  if (v === null || v === "") return "logo";
  return v === "dark" || v === "symbol" ? v : null;
}
