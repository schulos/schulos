// Schullogo: Angaben in app_settings und öffentliche Adresse – rein, ohne Server-Abhängigkeiten (auch in Client-Komponenten nutzbar).
import type { ImageMime } from "@/core/images";

/** Schullogo (P4-01…05): Hauptlogo, Variante für dunkle Flächen, quadratisches Symbol (Favicon, Monitor). */
export const LOGO_VARIANTS = ["logo", "dark", "symbol"] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];
export const LOGO_SETTING_KEYS: Record<LogoVariant, string> = { logo: "school.logo", dark: "school.logo_dark", symbol: "school.symbol" };

/** In app_settings gespeichert; die Datei liegt im Dateispeicher unter `key` (UUID). */
export interface LogoMeta {
  key: string;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  /** Inhaltsprüfsumme (gekürzt) – Versionsteil der Adresse, damit Browser nach einem Austausch neu laden */
  hash: string;
}
export type SchoolLogos = Partial<Record<LogoVariant, LogoMeta>>;

const LOGO_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rein: gespeicherten Wert prüfen – alles Unerwartete zählt als „kein Logo“. */
export function parseLogoMeta(v: unknown): LogoMeta | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
  const [width, height, bytes] = [num(o.width), num(o.height), num(o.bytes)];
  if (typeof o.key !== "string" || !UUID.test(o.key) || typeof o.mime !== "string" || !LOGO_MIMES.includes(o.mime)) return null;
  if (width === null || height === null || bytes === null || typeof o.hash !== "string" || !/^[0-9a-f]{8,64}$/.test(o.hash)) return null;
  return { key: o.key, mime: o.mime as ImageMime, width, height, bytes, hash: o.hash };
}

/** Öffentliche Adresse einer Logo-Variante, mit Version (lange Cache-Zeit in der Route). */
export function logoUrl(variant: LogoVariant, meta: Pick<LogoMeta, "hash">): string {
  return `/api/schule/logo?${variant === "logo" ? "" : `variante=${variant}&`}v=${meta.hash}`;
}
