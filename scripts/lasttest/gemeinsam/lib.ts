// Lasttest „gemeinsam bearbeiten“ (Gate 3b) – reine Bausteine des Lastgenerators (ohne Netz), damit sie sich mit Vitest
// prüfen lassen: SSE-Zerleger, Kennzahlen, simulierte Schreibende (Yjs wie der Editor) und Zeichnende (Excalidraw-Elemente
// wie die Tafel). Das Netz und den Ablauf macht run.ts.
import * as Y from "yjs";

// ---------------------------------------------------------------- Zufall (reproduzierbar je Person)

export type Rng = () => number;

/** mulberry32 – klein, schnell, reproduzierbar */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (r: Rng, min: number, max: number) => min + r() * (max - min);

// ---------------------------------------------------------------- Ziel nur Demo (G3B-06)

/** Rechnernamen, gegen die der Lastgenerator ohne ausdrückliche Freigabe schreiben darf */
export const DEMO_HOSTS = new Set(["demo.schulos.test", "localhost", "127.0.0.1", "[::1]"]);
/** Wegwerf-VM des Lasttests (scripts/lasttest.sh) bzw. der eigene Rechner */
const DEMO_IP = /^(192\.168\.251\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ZielPruefung {
  /** false → nicht schreiben (Grund in `grund`) */
  ok: boolean;
  grund?: string;
  /** Zertifikat prüfen? Abgeschaltet nur für die Wegwerf-VM bzw. den eigenen Rechner */
  tlsPruefen: boolean;
}

/**
 * Darf der Lauf gegen dieses Ziel schreiben? Nur gegen die Demo-VM bzw. localhost, sonst nur mit `freigabe`
 * (LASTTEST_ZIEL_OK=1). Die Zertifikatsprüfung bleibt an, außer die Verbindung geht in das Netz der Wegwerf-VM bzw. an
 * den eigenen Rechner.
 */
export function zielPruefen(base: URL, zielIp: string, freigabe: boolean): ZielPruefung {
  const ipOk = zielIp === "" || DEMO_IP.test(zielIp);
  const hostOk = DEMO_HOSTS.has(base.hostname);
  const lokal = zielIp ? DEMO_IP.test(zielIp) : LOOPBACK_HOSTS.has(base.hostname);
  const tlsPruefen = !lokal;
  if (hostOk && ipOk) return { ok: true, tlsPruefen };
  if (freigabe) return { ok: true, tlsPruefen };
  return {
    ok: false,
    tlsPruefen,
    grund: `Ziel ${base.hostname}${zielIp ? ` (${zielIp})` : ""} ist keine Demo-Instanz des Lasttests (erlaubt: ${[...DEMO_HOSTS].join(", ")}, IP 192.168.251.x) – nur mit LASTTEST_ZIEL_OK=1`,
  };
}

/** Zeigt die Anmeldeseite das Demo-Band? (DemoBand in packages/ui/src/misc.tsx – nur auf Demo-Instanzen) */
export const istDemoSeite = (html: string): boolean => /DEMO – keine echten Daten eingeben|VORSCHAU auf SchulOS/.test(html);

// ---------------------------------------------------------------- Server-Sent Events

export interface SseEvent {
  event: string;
  data: string;
}

/** Zerlegt den SSE-Strom in Ereignisse – Blöcke enden mit einer Leerzeile, Kommentare (`: ping`) fallen weg. */
export class SseParser {
  private buf = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: SseEvent[] = [];
    for (;;) {
      const end = this.buf.indexOf("\n\n");
      if (end < 0) break;
      const block = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  }
}

// ---------------------------------------------------------------- Kennzahlen

export interface Summary {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Perzentile nach dem Rang-Verfahren (nearest rank) – wie k6 für p(95) usw. ausreichend genau. */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { count: s.length, avg: round(s.reduce((a, b) => a + b, 0) / s.length), p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(s[s.length - 1]!) };
}

/** Sendezeitpunkte je Kennung (Text: `<clientID>:<uhr>`, Tafel: `<element>@<version>`) – Grundlage der Zustellverzögerung. */
export class SendBook {
  private sent = new Map<string, { at: number; from: number }>();

  /** `from`: wer gesendet hat (die eigene Rückmeldung zählt nicht als Zustellung an andere) */
  note(key: string, from: number, at: number): void {
    this.sent.set(key, { at, from });
  }

  /** Verzögerung bis zum Empfang bei `to`, oder null (eigenes Ereignis bzw. unbekannte Kennung) */
  delay(key: string, to: number, at: number): number | null {
    const s = this.sent.get(key);
    if (!s || s.from === to) return null;
    return at - s.at;
  }

  get size(): number {
    return this.sent.size;
  }
}

// ---------------------------------------------------------------- Text (Yjs wie @tiptap/y-tiptap)

/** Fragment-Name des Editors (texte/markdown.ts FRAGMENT) */
export const FRAGMENT = "default";
const LETTERS = "abcdefghijklmnopqrstuvwxyzäöüß        ,.";

/**
 * Eine Person am Text: eigener Y.Doc wie im Browser. Tippt in einen eigenen Absatz (Gruppenarbeit: jede:r schreibt am
 * eigenen Teil), löscht ab und zu, beginnt gelegentlich einen neuen Absatz. Lokale Änderungen sammeln sich wie im Editor
 * und gehen gebündelt raus (`takeBatch`, im Editor alle 300 ms).
 */
export class TextWriter {
  readonly doc = new Y.Doc();
  private queue: Uint8Array[] = [];
  private para: Y.XmlText | null = null;

  constructor(private readonly r: Rng) {
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== "remote") this.queue.push(u);
    });
  }

  get clientId(): number {
    return this.doc.clientID;
  }

  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, "remote");
  }

  private newParagraph(): Y.XmlText {
    const frag = this.doc.getXmlFragment(FRAGMENT);
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);
    return t;
  }

  /** ein Tastendruck */
  type(): void {
    if (!this.para || this.r() < 0.004) {
      this.para = this.newParagraph();
      return;
    }
    const t = this.para;
    if (t.length > 0 && this.r() < 0.08) {
      t.delete(t.length - 1, 1); // Rücktaste
      return;
    }
    // meist am Ende, manchmal mitten im eigenen Absatz (Korrektur)
    const pos = this.r() < 0.9 ? t.length : Math.floor(this.r() * (t.length + 1));
    t.insert(pos, LETTERS[Math.floor(this.r() * LETTERS.length)]!);
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Gesammeltes als ein Update (wie Y.mergeUpdates im Editor); `key` identifiziert es beim Empfänger (null = nur Löschen). */
  takeBatch(): { update: Uint8Array; key: string | null } | null {
    if (this.queue.length === 0) return null;
    const update = this.queue.length === 1 ? this.queue[0]! : Y.mergeUpdates(this.queue);
    this.queue = [];
    return { update, key: textKey(update, this.clientId) };
  }

  /** zurück in die Warteschlange (POST gescheitert) */
  requeue(update: Uint8Array): void {
    this.queue.unshift(update);
  }

  /** Inhalt als XML (für den Vergleich der Stände) */
  content(): string {
    return this.doc.getXmlFragment(FRAGMENT).toString();
  }
}

/**
 * Kennung eines Updates: Client und Uhr nach dem letzten Struct. Der Server verteilt das tatsächlich Neue (bei einem frischen
 * Update dasselbe Struct-Intervall) – daran erkennt der Empfänger, welches gesendete Bündel ankam. `client` = nur dessen
 * Structs (null, wenn das Update keine trägt: reines Löschen).
 */
export function textKey(update: Uint8Array, client?: number): string | null {
  const { to } = Y.parseUpdateMeta(update);
  if (client !== undefined) return to.has(client) ? `${client}:${to.get(client)}` : null;
  const first = [...to.entries()][0];
  return first ? `${first[0]}:${first[1]}` : null;
}

/** alle Kennungen eines empfangenen Updates (ein Update vom Server trägt normalerweise genau einen Client) */
export function textKeys(update: Uint8Array): string[] {
  return [...Y.parseUpdateMeta(update).to.entries()].map(([c, clock]) => `${c}:${clock}`);
}

/** trägt das Update neue Inhalte (Structs)? – Sync-Diffs ohne Neues tragen nur das DeleteSet */
export const hasStructs = (update: Uint8Array) => update.length > 2 && Y.parseUpdateMeta(update).to.size > 0;

export const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

// ---------------------------------------------------------------- Tafel (Excalidraw-Elemente)

export interface El {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  [key: string]: unknown;
}

/** gewinnt `a` gegen `b`? (höhere Version, bei Gleichstand kleinere Nonce – wie scene.ts, outbox.ts und Excalidraw) */
export const wins = (a: Pick<El, "version" | "versionNonce">, b: Pick<El, "version" | "versionNonce"> | undefined) =>
  !b || a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);

const BASE = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  roundness: null,
  boundElements: null,
  link: null,
  locked: false,
};

type Action = { kind: "stroke" | "rect" | "move"; el: El; until: number; dx: number; dy: number } | null;

/**
 * Eine Person an der Tafel: zeichnet Freihandstriche (~60 Punkte/s), Rechtecke, verschiebt eigene Elemente, löscht alte
 * (höchstens `keep` eigene stehen lassen – sonst wüchse die Tafel in 5 Minuten über jede realistische Größe). Jede Änderung
 * erhöht die Version (wie Excalidraw); `takeBundle` liefert, was seit dem letzten Bündel geändert wurde (Client: alle 250 ms).
 * `view` hält die ganze Tafel aus Sicht dieser Person (eigene + empfangene Elemente) für den Konsistenzvergleich.
 */
export class TafelDrawer {
  readonly view = new Map<string, El>();
  private own: string[] = [];
  private dirty = new Set<string>();
  private action: Action = null;
  private nextAt = 0;
  private n = 0;

  constructor(
    readonly idx: number,
    private readonly r: Rng,
    private readonly keep = 12,
  ) {}

  private bump(el: El) {
    el.version += 1;
    el.versionNonce = Math.floor(this.r() * 2 ** 31);
    this.view.set(el.id, el);
    this.dirty.add(el.id);
  }

  private create(type: string, now: number, extra: Record<string, unknown>): El {
    this.n += 1;
    const el: El = {
      ...BASE,
      id: `last-${this.idx}-${this.n}`,
      type,
      // Zeichenreihenfolge: eigener Präfix je Person, aufsteigend (Codepunkt-Sortierung wie scene.ts)
      index: `a${String(this.idx).padStart(3, "0")}${this.n.toString(36).padStart(5, "0")}`,
      x: Math.round(between(this.r, 0, 1600)),
      y: Math.round(between(this.r, 0, 900)),
      width: 0,
      height: 0,
      seed: Math.floor(this.r() * 2 ** 31),
      version: 0,
      versionNonce: 0,
      isDeleted: false,
      updated: now,
      ...extra,
    };
    this.own.push(el.id);
    this.bump(el);
    return el;
  }

  /** Zeit voranschreiten lassen (Aufruf etwa alle 50 ms) */
  step(now: number, dtMs: number): void {
    const a = this.action;
    if (a) {
      const el = a.el;
      if (a.kind === "stroke") {
        const pts = el.points as number[][];
        const last = pts[pts.length - 1]!;
        const count = Math.max(1, Math.round(dtMs / 16));
        for (let i = 0; i < count; i++) {
          a.dx += between(this.r, -0.6, 0.6);
          a.dy += between(this.r, -0.6, 0.6);
          const p = [Math.round((last[0]! + a.dx * (i + 1)) * 10) / 10, Math.round((last[1]! + a.dy * (i + 1)) * 10) / 10];
          pts.push(p);
        }
        const xs = pts.map((p) => p[0]!);
        const ys = pts.map((p) => p[1]!);
        el.width = Math.max(...xs) - Math.min(...xs);
        el.height = Math.max(...ys) - Math.min(...ys);
        el.pressures = [];
      } else if (a.kind === "rect") {
        el.width = Math.max(1, (el.width as number) + a.dx * (dtMs / 16));
        el.height = Math.max(1, (el.height as number) + a.dy * (dtMs / 16));
      } else {
        el.x = Math.round(((el.x as number) + a.dx * (dtMs / 16)) * 10) / 10;
        el.y = Math.round(((el.y as number) + a.dy * (dtMs / 16)) * 10) / 10;
      }
      this.bump(el);
      if (now >= a.until) {
        if (a.kind === "stroke") el.lastCommittedPoint = (el.points as number[][]).at(-1);
        this.action = null;
        this.nextAt = now + between(this.r, 1000, 6000); // überlegen, zuschauen
      }
      return;
    }
    if (now < this.nextAt) return;
    // alte eigene Elemente wegräumen (Radierer)
    if (this.own.length > this.keep) {
      const old = this.view.get(this.own.shift()!)!;
      old.isDeleted = true;
      this.bump(old);
      this.nextAt = now + between(this.r, 300, 1000);
      return;
    }
    const pick = this.r();
    if (pick < 0.65 || this.own.length === 0) {
      const el = this.create("freedraw", now, { points: [[0, 0]], pressures: [], simulatePressure: true, lastCommittedPoint: null });
      this.action = { kind: "stroke", el, until: now + between(this.r, 800, 3000), dx: between(this.r, -3, 3), dy: between(this.r, -3, 3) };
    } else if (pick < 0.8) {
      const el = this.create("rectangle", now, { width: 1, height: 1, backgroundColor: "#a5d8ff" });
      this.action = { kind: "rect", el, until: now + between(this.r, 500, 1500), dx: between(this.r, 1, 4), dy: between(this.r, 1, 3) };
    } else if (pick < 0.92) {
      const id = this.own[Math.floor(this.r() * this.own.length)]!;
      const el = this.view.get(id)!;
      this.action = { kind: "move", el, until: now + between(this.r, 400, 1200), dx: between(this.r, -4, 4), dy: between(this.r, -4, 4) };
    } else {
      const old = this.view.get(this.own.shift()!)!;
      old.isDeleted = true;
      this.bump(old);
      this.nextAt = now + between(this.r, 1000, 4000);
    }
  }

  get pending(): boolean {
    return this.dirty.size > 0;
  }

  /** geänderte Elemente seit dem letzten Bündel (Kopien – die Zeichnung läuft weiter) mit ihren Kennungen */
  takeBundle(): { elements: El[]; keys: string[] } | null {
    if (this.dirty.size === 0) return null;
    const elements = [...this.dirty].map((id) => structuredClone(this.view.get(id)!));
    this.dirty.clear();
    return { elements, keys: elements.map(tafelKey) };
  }

  /** Bündel zurücknehmen (POST gescheitert): beim nächsten Mal mit dem dann aktuellen Stand senden */
  requeue(elements: readonly El[]): void {
    for (const el of elements) this.dirty.add(el.id);
  }

  /** empfangene bzw. per Sync geholte Elemente übernehmen (je Element die gewinnende Fassung); liefert die Anzahl übernommener */
  applyRemote(elements: readonly El[]): number {
    let n = 0;
    for (const el of elements) {
      if (wins(el, this.view.get(el.id))) {
        this.view.set(el.id, el);
        n++;
      }
    }
    return n;
  }
}

export const tafelKey = (el: Pick<El, "id" | "version">) => `${el.id}@${el.version}`;

/** Fingerabdruck eines Tafelstands: je Element Version/Nonce/gelöscht, sortiert */
export function sceneFingerprint(elements: Iterable<El>): string {
  return [...elements]
    .map((e) => `${e.id}:${e.version}:${e.versionNonce}:${e.isDeleted ? 1 : 0}`)
    .sort()
    .join("|");
}

/** Wie viele Elemente unterscheiden sich zwischen zwei Ständen? (fehlend oder andere Fassung) */
export function sceneDiff(a: ReadonlyMap<string, El>, b: ReadonlyMap<string, El>): number {
  let n = 0;
  const ids = new Set([...a.keys(), ...b.keys()]);
  for (const id of ids) {
    const x = a.get(id);
    const y = b.get(id);
    if (!x || !y || x.version !== y.version || x.versionNonce !== y.versionNonce || x.isDeleted !== y.isDeleted) n++;
  }
  return n;
}

// ---------------------------------------------------------------- Anmeldeformular

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'", "#x27": "'", "#34": '"' };
const unescapeHtml = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m);

/** versteckte Felder eines HTML-Formulars (Server Action ohne JavaScript: `$ACTION_…`) */
export function hiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
    if (attr("type")?.toLowerCase() !== "hidden") continue;
    const name = attr("name");
    if (name) out[unescapeHtml(name)] = unescapeHtml(attr("value") ?? "");
  }
  return out;
}

/** multipart/form-data wie ein Browser-Formular */
export function multipart(fields: Record<string, string>): { body: string; type: string } {
  const boundary = "----schulos" + Math.random().toString(16).slice(2);
  let body = "";
  for (const [k, v] of Object.entries(fields)) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  return { body: body + `--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
}

/** Dauer wie bei k6 („5m“, „90s“, „1h“) in Millisekunden */
export function parseDuration(s: string): number {
  const m = /^(\d+)([smh])$/.exec(s.trim());
  if (!m) throw new Error(`Dauer „${s}“: z. B. 5m oder 90s`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}
