import type { GroupKind, Role, RoomEquipment, RoomKind } from "@/core/db/schema";

export const ROLE_LABELS: Record<Role, string> = {
  schueler: "Schüler:in",
  lehrkraft: "Lehrkraft",
  eltern: "Eltern",
  personal: "Personal",
  beratung: "Beratung",
  verwaltung: "Verwaltung",
  admin: "Administration",
};

export const GROUP_KIND_LABELS: Record<GroupKind, string> = {
  klasse: "Klasse",
  kurs: "Kurs",
  ag: "AG",
  fachschaft: "Fachschaft",
  gremium: "Gremium",
  frei: "Gruppe",
  wahlpflicht: "Wahlpflichtkurs",
  foerderkurs: "Förderkurs",
};

export const ROOM_KIND_LABELS: Record<RoomKind, string> = {
  klassenraum: "Klassenraum",
  nw: "Naturwissenschaften",
  informatik: "Informatik",
  kunst: "Kunst",
  musik: "Musik",
  sport: "Sporthalle",
  werkraum: "Werkraum",
  kueche: "Lehrküche",
  mensa: "Mensa",
  aula: "Aula",
  sonstiges: "Sonstiges",
};

export const ROOM_EQUIPMENT_LABELS: Record<RoomEquipment, string> = {
  beamer: "Beamer",
  tafel_digital: "Digitale Tafel",
  dokukamera: "Dokumentenkamera",
  lehrer_pc: "Lehrer-PC",
  schueler_pcs: "Schüler-PCs",
  audio: "Audioanlage",
  waschbecken: "Waschbecken",
  abzug: "Abzug",
};

const TZ = "Europe/Berlin";

/** „Guten Morgen" / „Guten Tag" / „Guten Abend" nach deutscher Uhrzeit. */
export function greeting(now = new Date()): string {
  // formatToParts statt format: de-DE liefert sonst „08 Uhr".
  const hour = Number(
    new Intl.DateTimeFormat("de-DE", { hour: "numeric", hourCycle: "h23", timeZone: TZ })
      .formatToParts(now)
      .find((p) => p.type === "hour")?.value,
  );
  if (hour < 11) return "Guten Morgen";
  if (hour < 18) return "Guten Tag";
  return "Guten Abend";
}

/** „Montag, 5. Oktober" */
export function formatLongDate(now = new Date()): string {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(now);
}
