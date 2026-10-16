// Tafeln (P3-12): Szene als Excalidraw-JSON – rein (ohne DB/Speicher), damit es sich direkt testen lässt.
//
// Abgleich je Element wie in Excalidraw selbst (data/reconcile): jedes Element trägt `version` (steigt mit jeder Änderung)
// und `versionNonce` (Zufall je Änderung). Gewinnt die höhere Version; bei gleicher Version die kleinere Nonce – so kommen
// alle Beteiligten unabhängig von der Reihenfolge zum selben Ergebnis. Gelöschte Elemente bleiben als Grabstein
// (`isDeleted: true`) stehen, damit eine verspätete ältere Fassung sie nicht wiederbelebt; nach einem Tag fallen sie weg.
// Ein Grabstein trägt nur, was der Abgleich braucht (P312-03) – Text, Punkte, Verweise usw. sind beim Übernehmen sofort weg,
// landen also weder in der Datei noch beim Sync bei den anderen. Die Ablaufzeit (`updated`) setzt der Server (P312-06).
// Die Reihenfolge (Zeichenebenen) steckt im Feld `index` (Fractional Index, base62) – sortiert wird nach Codepunkten.

export interface BoardElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  updated?: number;
  [key: string]: unknown;
}

/**
 * Erlaubte Elementarten. Nicht dabei: Bilder (bräuchten Binärdateien neben der Szene), eingebettete Webseiten
 * (`embeddable`/`iframe` – fremde Inhalte, CSP) und KI-Rahmen (`magicframe`).
 */
export const ELEMENT_TYPES = new Set(["rectangle", "diamond", "ellipse", "arrow", "line", "freedraw", "text", "frame"]);

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const INDEX = /^[0-9A-Za-z]{1,256}$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
/** Koordinaten jenseits davon sind Unsinn und bringen die Zeichenfläche der anderen durcheinander */
const MAX_COORD = 1e7;
const NUMERIC = ["x", "y", "width", "height", "angle"] as const;
const LINEAR = new Set(["arrow", "line", "freedraw"]);

export const DEFAULT_BACKGROUND = "#ffffff";
/** Grabsteine (gelöschte Elemente) so lange aufheben */
export const TOMBSTONE_MS = 24 * 60 * 60_000;

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

/** Verweise nur auf Webadressen oder innerhalb von SchulOS – kein `javascript:`/`data:`. */
export function safeLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  return null;
}

/**
 * Obergrenze für `version` (G3B-02): Excalidraw erhöht sie je Änderung um 1, im Alltag bleibt sie weit darunter. Ohne Grenze
 * ließe sich ein Element auf 2^53−1 setzen – jede weitere Änderung (auch das Löschen) wäre dann keine sichere Ganzzahl mehr
 * und würde verworfen. Die Nonce bleibt im Bereich, den Excalidraw selbst erzeugt (±2^31).
 */
export const MAX_VERSION = 2 ** 31;
/** höchstens so viel darf eine Fassung die bekannte überspringen (live.ts) – auch offline Gezeichnetes bleibt weit darunter */
export const MAX_VERSION_STEP = 10_000;

/** Kennung eines (evtl. ungültigen) Elements, falls sie brauchbar ist – für die Rückmeldung „verworfen“ an den Client. */
export function elementId(raw: unknown): string | null {
  const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
  return typeof id === "string" && ID.test(id) ? id : null;
}

// ------------------------------------------------------------------- Allowlist je Elementart (G3B-01)
//
// Excalidraws `restoreElements` ist bei falschen Typen nicht robust (z. B. `boundElementIds: 1` → „map is not a function“,
// Text mit `font: 1` → „split is not a function“) und wirft dann für die ganze Szene. Deshalb übernimmt der Server nur
// bekannte Felder mit passendem Typ und baut verschachtelte Objekte neu auf. Unbekannte Felder fallen weg; ein Feld mit
// falschem Typ ebenso (Excalidraw setzt dafür seine Vorgabe ein). Geometrie (x/y/Breite/Höhe/Winkel, Punkte) mit falschem
// Typ verwirft das ganze Element.

/** Prüft einen Wert und liefert ihn (ggf. neu aufgebaut) oder `undefined` = Feld weglassen */
type Field = (v: unknown) => unknown;

const COLOR_EL = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/;
const MAX_TEXT = 100_000;
const num =
  (min: number, max: number): Field =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const int =
  (min: number, max: number): Field =>
  (v) =>
    Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v : undefined;
const bool: Field = (v) => (typeof v === "boolean" ? v : undefined);
const str =
  (max: number): Field =>
  (v) =>
    typeof v === "string" && v.length <= max ? v : undefined;
const oneOf =
  (...values: string[]): Field =>
  (v) =>
    typeof v === "string" && values.includes(v) ? v : undefined;
const nullable =
  (f: Field): Field =>
  (v) =>
    v === null ? null : f(v);
const color: Field = (v) => (typeof v === "string" && COLOR_EL.test(v) ? v : undefined);
const id: Field = (v) => (typeof v === "string" && ID.test(v) ? v : undefined);
const coord = num(-MAX_COORD, MAX_COORD);
const point: Field = (v) => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);
/** Liste, deren Einträge alle passen müssen (sonst fällt das ganze Feld weg) */
const list =
  (f: Field, max: number): Field =>
  (v) => {
    if (!Array.isArray(v) || v.length > max) return undefined;
    const out: unknown[] = [];
    for (const x of v) {
      const c = f(x);
      if (c === undefined) return undefined;
      out.push(c);
    }
    return out;
  };
/** Objekt neu aufbauen: Pflichtfelder müssen passen, optionale fallen bei falschem Typ weg */
const shape =
  (required: Record<string, Field>, optional: Record<string, Field> = {}): Field =>
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(required)) {
      const c = f(o[k]);
      if (c === undefined) return undefined;
      out[k] = c;
    }
    for (const [k, f] of Object.entries(optional)) {
      if (!(k in o)) continue;
      const c = f(o[k]);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };

const binding = nullable(shape({ elementId: id, focus: coord, gap: coord }, { fixedPoint: nullable(point) }));
const ARROWHEADS = ["arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"];
const arrowhead = nullable(oneOf(...ARROWHEADS));

const BASE_FIELDS: Record<string, Field> = {
  strokeColor: color,
  backgroundColor: color,
  fillStyle: oneOf("hachure", "cross-hatch", "solid", "zigzag"),
  strokeWidth: num(0, 1000),
  strokeStyle: oneOf("solid", "dashed", "dotted"),
  roundness: nullable(shape({ type: int(1, 3) }, { value: num(0, MAX_COORD) })),
  roughness: num(0, 10),
  opacity: num(0, 100),
  seed: int(-MAX_VERSION, MAX_VERSION),
  groupIds: list(id, 256),
  frameId: nullable(id),
  boundElements: nullable(list(shape({ id, type: oneOf("arrow", "text") }), 2000)),
  updated: num(0, Number.MAX_SAFE_INTEGER),
  locked: bool,
};
const LINEAR_FIELDS: Record<string, Field> = {
  lastCommittedPoint: nullable(point),
  startBinding: binding,
  endBinding: binding,
  startArrowhead: arrowhead,
  endArrowhead: arrowhead,
};
const TYPE_FIELDS: Record<string, Record<string, Field>> = {
  rectangle: {},
  diamond: {},
  ellipse: {},
  frame: { name: nullable(str(1000)) },
  text: {
    fontSize: num(0.1, 10_000),
    fontFamily: int(1, 1000),
    text: str(MAX_TEXT),
    originalText: str(MAX_TEXT),
    textAlign: oneOf("left", "center", "right"),
    verticalAlign: oneOf("top", "middle", "bottom"),
    containerId: nullable(id),
    autoResize: bool,
    lineHeight: num(0.1, 100),
  },
  line: LINEAR_FIELDS,
  arrow: {
    ...LINEAR_FIELDS,
    elbowed: bool,
    fixedSegments: nullable(list(shape({ start: point, end: point, index: int(0, 1_000_000) }), 1000)),
    startIsSpecial: nullable(bool),
    endIsSpecial: nullable(bool),
  },
  freedraw: {
    lastCommittedPoint: nullable(point),
    pressures: list(num(0, 1000), 1_000_000),
    simulatePressure: bool,
  },
};

/** Ein Element prüfen; null = unbrauchbar (falsche Art, Version außerhalb der Grenzen, kaputte Geometrie). */
export function sanitizeElement(raw: unknown): BoardElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const el = raw as Record<string, unknown>;
  if (typeof el.id !== "string" || !ID.test(el.id)) return null;
  if (typeof el.type !== "string" || !ELEMENT_TYPES.has(el.type)) return null;
  if (!Number.isSafeInteger(el.version) || (el.version as number) < 1 || (el.version as number) > MAX_VERSION) return null;
  if (!Number.isSafeInteger(el.versionNonce) || Math.abs(el.versionNonce as number) > MAX_VERSION) return null;
  if (typeof el.isDeleted !== "boolean") return null;
  const index = el.index ?? null;
  if (index !== null && (typeof index !== "string" || !INDEX.test(index))) return null;
  if (el.isDeleted) return tombstone(el as BoardElement, index);
  if ("fileId" in el && el.fileId != null) return null;
  const out: BoardElement = { id: el.id, type: el.type, version: el.version as number, versionNonce: el.versionNonce as number, isDeleted: false, index };
  for (const k of NUMERIC) {
    if (!(k in el)) continue;
    if (!finite(el[k])) return null;
    out[k] = el[k];
  }
  if (LINEAR.has(el.type) && "points" in el) {
    const points = list(point, 100_000)(el.points);
    if (points === undefined) return null;
    out.points = points;
  }
  for (const [k, f] of [...Object.entries(BASE_FIELDS), ...Object.entries(TYPE_FIELDS[el.type]!)]) {
    if (!(k in el)) continue;
    const c = f(el[k]);
    if (c !== undefined) out[k] = c;
  }
  // ohne Druckwerte stürzt das Zeichnen von Freihand ab (pressures[i]) – leer heißt „gleichmäßig“
  if (el.type === "freedraw" && out.pressures === undefined) out.pressures = [];
  if ("link" in el) out.link = safeLink(el.link);
  return out;
}

/**
 * Grabstein: nur Kennung, Art, Version/Nonce, Reihenfolge und Zeitstempel (P312-03). Dazu eine Mini-Geometrie, weil
 * Excalidraws `restoreElements` unsichtbar kleine Elemente (Breite und Höhe 0, Linien ohne zwei Punkte) still verwirft – dann
 * käme die Löschung bei den anderen nicht an.
 */
export function tombstone(el: BoardElement, index: string | null = el.index ?? null): BoardElement {
  const t: BoardElement = { id: el.id, type: el.type, version: el.version, versionNonce: el.versionNonce, isDeleted: true, index, x: 0, y: 0, width: 1, height: 1, angle: 0 };
  if (LINEAR.has(el.type)) t.points = [[0, 0], [1, 1]];
  if (typeof el.updated === "number" && Number.isFinite(el.updated)) t.updated = el.updated;
  return t;
}

/** Gewinnt `incoming` gegen `current`? (höhere Version; bei Gleichstand die kleinere Nonce) */
export function wins(incoming: Pick<BoardElement, "version" | "versionNonce">, current: Pick<BoardElement, "version" | "versionNonce"> | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

/**
 * Eingehende Elemente in den Stand übernehmen (nur, wo sie gewinnen). Liefert die tatsächlich übernommenen – nur die gehen
 * an die anderen. Ein unbekanntes, schon gelöschtes Element wird nicht angelegt (nichts zu begraben).
 */
export function mergeElements(current: Map<string, BoardElement>, incoming: readonly BoardElement[]): BoardElement[] {
  const changed: BoardElement[] = [];
  for (const el of incoming) {
    const have = current.get(el.id);
    if (!have && el.isDeleted) continue;
    if (!wins(el, have)) continue;
    current.set(el.id, el);
    changed.push(el);
  }
  return changed;
}

/** Zeichenreihenfolge: nach `index` (Codepunkte – base62 ist in ASCII aufsteigend), ohne Index ans Ende. */
export function orderElements(elements: Iterable<BoardElement>): BoardElement[] {
  return [...elements].sort((a, b) => {
    if (a.index === b.index) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return a.index < b.index ? -1 : 1;
  });
}

/** Grabsteine, die älter als TOMBSTONE_MS sind, entfernen (ohne `updated`: bleiben). Liefert die Anzahl. */
export function pruneTombstones(current: Map<string, BoardElement>, now: number, maxAgeMs = TOMBSTONE_MS): number {
  let n = 0;
  for (const [id, el] of current) {
    if (el.isDeleted && typeof el.updated === "number" && el.updated < now - maxAgeMs) {
      current.delete(id);
      n++;
    }
  }
  return n;
}

export interface Scene {
  elements: BoardElement[];
  background: string;
  /** beim Lesen verworfene Elemente (Bilder, eingebettete Seiten, Kaputtes) */
  dropped: number;
  /** Grabsteine, die in der Datei noch Inhalt trugen (ältere Fassung) – beim nächsten Speichern ist er weg */
  thinned: number;
}

/** Datei lesen; null = keine Excalidraw-Szene. Unbrauchbare Elemente werden verworfen und gezählt. */
export function parseScene(text: string): Scene | null {
  if (text.trim() === "") return { elements: [], background: DEFAULT_BACKGROUND, dropped: 0, thinned: 0 };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as { type?: unknown; elements?: unknown; appState?: { viewBackgroundColor?: unknown } };
  if (d.type !== undefined && d.type !== "excalidraw") return null;
  if (!Array.isArray(d.elements)) return null;
  const byId = new Map<string, BoardElement>();
  let dropped = 0;
  let thinned = 0;
  for (const raw of d.elements) {
    const el = sanitizeElement(raw);
    if (!el) dropped++;
    else {
      if (el.isDeleted && Object.keys(raw as object).some((k) => !(k in el))) thinned++;
      // nicht mergeElements: Grabsteine aus der Datei müssen erhalten bleiben (sonst belebt nach einem Neustart ein Client,
      // der die Löschung verpasst hat, das Element wieder)
      if (wins(el, byId.get(el.id))) byId.set(el.id, el);
    }
  }
  const bg = d.appState?.viewBackgroundColor;
  return { elements: orderElements(byId.values()), background: typeof bg === "string" && COLOR.test(bg) ? bg : DEFAULT_BACKGROUND, dropped, thinned };
}

/** Datei schreiben – im Format, das Excalidraw selbst öffnet (`.excalidraw`). */
export function serializeScene(elements: Iterable<BoardElement>, background = DEFAULT_BACKGROUND): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "SchulOS",
    elements: orderElements(elements),
    appState: { viewBackgroundColor: background, gridSize: null },
    files: {},
  });
}

export const elementBytes = (el: BoardElement): number => Buffer.byteLength(JSON.stringify(el)) + 1;

/** Dateiname einer Tafel: bereinigt, mit Endung „.excalidraw“. */
export const BOARD_EXT = ".excalidraw";
export const isBoardName = (name: string): boolean => name.toLowerCase().endsWith(BOARD_EXT) && name.length > BOARD_EXT.length;
export function boardFileName(title: string): string {
  const t = title.trim().replace(/\.excalidraw$/i, "").trim();
  return `${t}${BOARD_EXT}`;
}
export const boardTitle = (name: string): string => (isBoardName(name) ? name.slice(0, -BOARD_EXT.length) : name);
