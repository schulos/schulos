// RS-11: QR-Code als SVG für Schilder und Etiketten (gemeinsamer Unterbau). Bibliothek `uqr` wie bei der Zwei-Faktor-Einrichtung;
// die Kurz-URL kommt aus der Basisadresse der Instanz (BETTER_AUTH_URL, wie Links in Mails).
import { renderSVG } from "uqr";
import { appUrl } from "@/core/mail";
import { labelPath, type LabelKind } from "./codes";

/** Volle Kurz-URL eines Codes, z. B. `https://schule.example/r/7K3M…`. */
export function labelUrl(kind: LabelKind, code: string): string {
  return appUrl(labelPath(kind, code));
}

/** SVG-Markup (nur aus der selbst erzeugten URL, kein Fremdinhalt) mit Ruhezone; Fehlerkorrektur M reicht für Papier. */
export function qrSvg(text: string): string {
  return renderSVG(text, { border: 2, ecc: "M" });
}
