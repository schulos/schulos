import { dayOptions, defineSetting } from "@/core/modules/settings";

/**
 * DS-15: Karenz zwischen Abgang und Löschung eines Kontos (LK-KONTO, `ACCOUNT_GRACE_DAYS` als Vorgabe). Kürzer als 30 Tage
 * nicht (Eigenexport, Rückfragen), länger als ein Jahr nicht (Grenze der Löschklasse).
 */
export const ACCOUNT_GRACE = defineSetting({
  key: "verwaltung.account_grace",
  label: "Konten nach dem Abgang löschen",
  help: "Bis dahin ist das Konto gesperrt; Eigenexport und Rückfragen bleiben möglich. Löschsperren und die Klassenbuch-Akte gehen vor.",
  options: dayOptions([30, 90, 180, 365], 90),
  default: "90",
  permission: "verwaltung.privacy",
});

export const VERWALTUNG_SETTINGS = [ACCOUNT_GRACE];
