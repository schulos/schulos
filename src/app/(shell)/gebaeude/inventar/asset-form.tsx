// INV-01: Felder des Inventar-Formulars (Anlegen und Ändern) als Daten für `SpecForm`.
import { MAX_NOTICE_MONTHS, type AssetRow } from "@/modules/gebaeude/pruefungen";
import { ASSET_CONDITIONS, CONDITION_LABELS } from "@/modules/gebaeude/labels";
import type { FieldSpec } from "@/ui/spec-form";

type Option = { value: string; label: string };

export interface AssetFormOptions {
  categories: Option[];
  rooms: Option[];
  buildings: Option[];
  floors: Option[];
}

const euro = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));

export function assetFields(o: AssetFormOptions, a?: AssetRow): FieldSpec[] {
  return [
    { name: "name", label: "Bezeichnung", type: "text", required: true, maxLength: 120, wide: true, placeholder: "z. B. Tablet-Koffer 7. Jahrgang", defaultValue: a?.name },
    { name: "categoryId", label: "Kategorie", type: "select", options: o.categories, defaultValue: a?.categoryId },
    { name: "inventoryNo", label: "Inventarnummer", type: "text", maxLength: 40, defaultValue: a?.inventoryNo ?? "", hint: a ? undefined : "leer = automatisch aus dem Zähler der Kategorie" },
    { name: "quantity", label: "Menge", type: "number", min: 1, max: 9999, defaultValue: String(a?.quantity ?? 1), hint: "mehr als 1 = Sammelposten (z. B. Stühle je Raum)" },
    { name: "roomId", label: "Raum", type: "select", options: [{ value: "", label: "kein Raum" }, ...o.rooms], defaultValue: a?.roomId ?? "" },
    { name: "buildingId", label: "Gebäude", type: "select", options: [{ value: "", label: "aus dem Raum" }, ...o.buildings], defaultValue: a?.buildingId ?? "", hint: "ohne Raum oder abweichend" },
    { name: "floorId", label: "Etage", type: "select", options: [{ value: "", label: "–" }, ...o.floors], defaultValue: "" },
    { name: "condition", label: "Zustand", type: "select", options: [{ value: "", label: "–" }, ...ASSET_CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABELS[c] }))], defaultValue: a?.condition ?? "" },
    { name: "manufacturer", label: "Hersteller", type: "text", maxLength: 80, defaultValue: a?.manufacturer ?? "" },
    { name: "model", label: "Modell", type: "text", maxLength: 80, defaultValue: a?.model ?? "" },
    { name: "serial", label: "Seriennummer", type: "text", maxLength: 80, defaultValue: a?.serial ?? "" },
    { name: "acquiredOn", label: "angeschafft am", type: "date", defaultValue: a?.acquiredOn ?? "", hint: a ? undefined : "ohne Angabe ist die erste Prüfung sofort fällig" },
    { name: "price", label: "Preis (Euro)", type: "text", maxLength: 16, placeholder: "z. B. 1.234,56", defaultValue: a ? euro(a.priceCents) : "" },
    { name: "supplier", label: "Lieferant (Firma)", type: "text", maxLength: 120, defaultValue: a?.supplier ?? "" },
    { name: "financing", label: "Finanzierung/Förderung", type: "text", maxLength: 120, defaultValue: a?.financing ?? "", hint: "z. B. Schulträger, Förderprogramm" },
    { name: "boundUntil", label: "Zweckbindung bis", type: "date", defaultValue: a?.boundUntil ?? "" },
    { name: "warrantyUntil", label: "Garantie bis", type: "date", defaultValue: a?.warrantyUntil ?? "" },
    // INV-08: Wartungs-/Servicevertrag am Gerät (Firma, kein Feld für Ansprechpersonen)
    { name: "servicePartner", label: "Wartungspartner (Firma)", type: "text", maxLength: 120, defaultValue: a?.servicePartner ?? "", hint: "Wartungs- oder Servicevertrag, z. B. Aufzugsfirma" },
    { name: "serviceEnd", label: "Vertragsende", type: "date", defaultValue: a?.serviceEnd ?? "" },
    { name: "serviceNoticeMonths", label: "Kündigungsfrist (Monate)", type: "number", min: 0, max: MAX_NOTICE_MONTHS, defaultValue: a?.serviceNoticeMonths ? String(a.serviceNoticeMonths) : "", hint: "vor dem Vertragsende; leer = keine" },
    { name: "serviceNote", label: "Vertragsnotiz", type: "textarea", maxLength: 300, wide: true, defaultValue: a?.serviceNote ?? "", hint: "Leistung, Vertragsnummer – keine Namen oder Telefonnummern von Personen" },
    { name: "note", label: "Notiz", type: "textarea", maxLength: 500, wide: true, defaultValue: a?.note ?? "", hint: "Sachangaben – keine Namen oder Angaben zu Personen" },
  ];
}
