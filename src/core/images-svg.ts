// SVG-Annahmefilter (P4-02, Q-12). In Node gibt es weder DOM noch DOMPurify – deshalb drei Schichten (docs/SICHERHEIT.md S8b):
// 1. dieser Filter lehnt ab, statt zu „reparieren“ (Negativ-Liste unten, getestet in images-svg.test.ts),
// 2. die Logo-Route liefert mit festem Content-Type, `nosniff` und CSP `sandbox` aus,
// 3. eingebunden wird nur als <img> (dort führen Browser kein Skript aus und laden nichts nach).
// Der Filter ist bewusst streng: lieber ein Logo ablehnen (Hinweis „als PNG speichern“) als eines zu viel annehmen.
import { svgSize, type ImageSize } from "@/core/images";

/** Höchste Verschachtelungstiefe und Elementzahl – echte Logos liegen weit darunter. */
export const SVG_MAX_DEPTH = 48;
export const SVG_MAX_ELEMENTS = 20_000;
/** `<use>` kann Gruppen vervielfachen (Kaskaden über `#`-Verweise) – echte Logos brauchen nur wenige. */
export const SVG_MAX_USES = 200;

/** Elemente, die Skript, fremde Dokumente oder Medien einbetten können (auch mit Präfix, z. B. `<x:script>`). */
const BLOCKED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "frame",
  "frameset",
  "embed",
  "object",
  "applet",
  "portal",
  "handler",
  "listener",
  "html",
  "head",
  "body",
  "meta",
  "link",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "audio",
  "video",
  "canvas",
]);

/** Muster, die nach Entschlüsseln von Zeichenreferenzen und Entfernen aller Leerzeichen nirgends vorkommen dürfen. */
const BLOCKED_TEXT: [string, string][] = [
  ["javascript:", "enthält einen Skript-Link (javascript:)"],
  ["vbscript:", "enthält einen Skript-Link (vbscript:)"],
  ["livescript:", "enthält einen Skript-Link"],
  ["data:text", "bettet ein Dokument ein (data:text)"],
  ["data:application", "bettet ein Dokument ein (data:application)"],
  ["data:image/svg", "bettet ein weiteres SVG ein"],
  ["<script", "enthält ein Skript"],
  ["<foreignobject", "enthält fremde Inhalte (foreignObject)"],
  ["@import", "lädt Stile nach (@import)"],
  ["expression(", "enthält aktive Stile (expression)"],
  ["-moz-binding", "enthält aktive Stile (-moz-binding)"],
  ["behavior:", "enthält aktive Stile (behavior)"],
  ["1999/xhtml", "enthält HTML-Inhalte (XHTML-Namensraum)"],
  ["1998/math/mathml", "enthält MathML-Inhalte"],
];

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i;
const NAMED_REFS: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", lpar: "(", rpar: ")", sol: "/", period: "." };

/** Zeichenreferenzen (`&#106;`, `&#x6a;`, `&colon;` …) entschlüsseln – Verschleierungen wie `&#106;avascript:` fallen so auf. */
function decodeRefs(s: string): string {
  const cp = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => cp(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_REFS[name.toLowerCase()] ?? m);
}

/** Zum Vergleichen: entschlüsselt, klein, ohne Leer-/Steuerzeichen (gegen `java\tscript:`). */
const squeeze = (s: string) => decodeRefs(s).toLowerCase().replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]+/g, "");

/** Verweis auf etwas anderes als ein Fragment im selben Dokument oder ein eingebettetes Rasterbild? */
const isForeignRef = (raw: string) => {
  const v = squeeze(raw).replace(/^['"]|['"]$/g, "");
  return !(v === "" || v.startsWith("#") || DATA_IMAGE.test(v));
};

/** Gibt es ein `open` ohne folgendes `close`? Linear: springt von Abschnitt zu Abschnitt (statt Vorausschau je Fundstelle). */
function unclosed(s: string, open: string, close: string): boolean {
  let i = 0;
  while ((i = s.indexOf(open, i)) !== -1) {
    const j = s.indexOf(close, i + open.length);
    if (j === -1) return true;
    i = j + close.length;
  }
  return false;
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[\w.:-]/;

/**
 * Linearer Durchlauf über alle Tags (`<name …>`, `</name>`, `<name/>`): zählt Elemente, Tiefe und `<use>`. Anführungszeichen
 * in Attributen werden mitgeführt, ein Tag ohne `>` (oder mit offenem Anführungszeichen) wird abgelehnt. Grund oder null.
 */
function scanElements(body: string): string | null {
  const n = body.length;
  let depth = 0;
  let count = 0;
  let uses = 0;
  let i = 0;
  while ((i = body.indexOf("<", i)) !== -1) {
    let j = i + 1;
    const closing = body[j] === "/";
    if (closing) j++;
    if (!NAME_START.test(body[j] ?? "")) {
      i = j;
      continue;
    }
    const nameStart = j;
    while (j < n && NAME_CHAR.test(body[j]!)) j++;
    const name = body.slice(nameStart, j);
    const attrStart = j;
    let quote = "";
    for (; j < n; j++) {
      const c = body[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (j >= n) return "ist kein gültiges SVG (Element nicht geschlossen)";
    i = j + 1;
    if (closing) {
      depth--;
      continue;
    }
    if (++count > SVG_MAX_ELEMENTS) return "ist zu umfangreich";
    if (name.split(":").pop()!.toLowerCase() === "use" && ++uses > SVG_MAX_USES) return "hat zu viele Verweise (<use>)";
    let k = j - 1;
    while (k >= attrStart && /\s/.test(body[k]!)) k--;
    const selfClosing = k >= attrStart && body[k] === "/";
    if (!selfClosing && ++depth > SVG_MAX_DEPTH) return "ist zu tief verschachtelt";
  }
  return null;
}

/** Rein: prüft den schon als UTF-8 gelesenen Inhalt eines SVG – angenommen mit Maßen oder abgelehnt mit Grund (Alltagssprache). */
export function inspectSvg(text: string): SvgCheck {
  const no = (reason: string): SvgCheck => ({ ok: false, reason });
  if (text.includes("\u0000")) return no("ist keine Textdatei");
  const src = text.replace(/^\ufeff/, "");
  const flat = squeeze(src);
  if (flat.includes("<!entity")) return no("enthält Entity-Definitionen");
  for (const [needle, reason] of BLOCKED_TEXT) if (flat.includes(needle)) return no(reason);

  // Kommentare und CDATA-Abschnitte für die Strukturprüfung ausblenden (ihr Inhalt lief oben schon durch die Musterprüfung)
  if (unclosed(src, "<!--", "-->")) return no("hat einen nicht geschlossenen Kommentar");
  if (unclosed(src, "<![CDATA[", "]]>")) return no("hat einen nicht geschlossenen CDATA-Abschnitt");
  let body = src.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");

  // Prolog: höchstens die XML-Deklaration (ganz vorn) und ein DOCTYPE für SVG ohne interne Definitionen
  body = body.replace(/^\s*<\?xml\s[^?]*\?>/, " ");
  if (body.includes("<?")) return no("enthält Verarbeitungsanweisungen (z. B. xml-stylesheet)");
  // `>?`: ein DOCTYPE ohne Ende läuft bis zum Textende und fällt unten durch – ohne erneuten Suchlauf je Fundstelle (linear)
  const doctypes = body.match(/<!doctype[^>]*>?/gi) ?? [];
  if (doctypes.length > 1 || doctypes.some((d) => !/^<!DOCTYPE\s+svg(?:\s+PUBLIC\s+"[^"[\]]*"\s+"[^"[\]]*")?\s*>$/i.test(d)))
    return no("hat eine unzulässige DOCTYPE-Angabe");
  body = body.replace(/<!doctype[^>]*>?/gi, " ").trim();
  if (body.includes("<!")) return no("enthält unzulässige Deklarationen");
  if (!/^<svg[\s>/]/.test(body)) return no("beginnt nicht mit einem <svg>-Element");
  if (!/<\/svg\s*>$/.test(body) && !/^<svg\b[^>]*\/>$/.test(body)) return no("endet nicht mit </svg>");

  // Elemente – auch in kaputten Tags und mit Präfix (`<x:script>`)
  for (const m of body.matchAll(/<\/?([A-Za-z_][\w.:-]*)/g)) {
    const local = m[1]!.split(":").pop()!.toLowerCase();
    if (BLOCKED_ELEMENTS.has(local)) return no(`enthält ein <${local}>-Element`);
  }
  // Attribute – über den ganzen Text statt nur in sauber erkannten Tags
  const decoded = decodeRefs(body);
  const handler = /(?:^|[\s"'/])((?:[\w.-]+:)?on[a-z]+)\s*=/i.exec(decoded);
  if (handler) return no(`enthält ein Ereignis-Attribut (${handler[1]!.toLowerCase()})`);
  // Werte in Anführungszeichen: ohne schließendes Zeichen bis zum Textende (statt Rückverfolgung je Fundstelle → linear)
  for (const a of decoded.matchAll(/(?:^|[\s"'/])(?:[\w.-]+:)?(href|src)\s*=\s*("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'>]+)/gi))
    if (isForeignRef(a[2]!)) return no("verweist auf externe Inhalte");
  for (const a of decoded.matchAll(/attributename\s*=\s*("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'>]+)/gi))
    if (/href$/.test(squeeze(a[1]!).replace(/['"]/g, ""))) return no("verändert Verweise per Animation");
  // url(…) in Stilen und Attributen: nur Fragmente (#verlauf) und eingebettete Rasterbilder
  // `\)?`: ein offenes `url(` reicht bis zum Textende (gilt dann als fremder Verweis) – linear statt quadratisch (SEC: DoS)
  for (const u of flat.matchAll(/url\(([^)]*)\)?/g)) if (isForeignRef(u[1]!)) return no("lädt Inhalte von außen nach (url)");

  // Umfang: Tiefe und Zahl der Elemente – eigener linearer Scanner (ein Regex mit Anführungszeichen-Alternativen lief bei
  // offenen Anführungszeichen quadratisch und blockierte den Prozess minutenlang, Security-Review Gate 4a N1)
  const scan = scanElements(body);
  if (scan) return no(scan);
  const size = svgSize(body);
  return size ? { ok: true, size } : no("hat keine Größenangabe (width/height oder viewBox)");
}

/** Rein: Grund, warum ein SVG abgelehnt wird, oder null. */
export function svgProblem(text: string): string | null {
  const r = inspectSvg(text);
  return r.ok ? null : r.reason;
}

/** Sieht die Datei wie ein SVG aus (Text mit `<svg` am Anfang)? Entscheidet nur, welcher Prüfweg greift. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).toLowerCase();
  return /^\ufeff?\s*(<\?xml|<!--|<!doctype\s+svg|<svg[\s>/])/.test(head) && head.includes("<svg");
}

/** Ergebnis einer SVG-Prüfung: angenommen mit Maßen oder abgelehnt mit Grund. */
export type SvgCheck = { ok: true; size: ImageSize } | { ok: false; reason: string };

/** Rein: prüft eine hochgeladene SVG-Datei (UTF-8, Annahmefilter, Maße). */
export function checkSvg(bytes: Uint8Array): SvgCheck {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "ist nicht als UTF-8 gespeichert" };
  }
  return inspectSvg(text);
}
