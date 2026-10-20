// Schulbücherei – optionale ISBN-Abfrage (BU-06, Entscheidung 5 in docs/BUECHEREI.md): Titelangaben zu einer ISBN aus
// öffentlichen Bibliothekskatalogen vorschlagen. Ab Werk aus (`buecherei.isbn`, ändern nur mit `verwaltung.privacy`), nur
// serverseitig, nur die ISBN verlässt den Server (keine Namen, keine Schule, keine Cookies), Quellen der Reihe nach und einzeln
// abschaltbar (ab Werk nur die Kataloge in Deutschland; Open Library außerhalb der EU ist aus – GATE BU1), Zeitlimit insgesamt ~5 s, Ergebnis nur als Vorschlag zum Prüfen. Ohne Internet (Schulnetz ohne Außenzugang)
// kommt eine Meldung statt eines Fehlers. Zwischenspeicher im Prozess, damit dieselbe ISBN nicht mehrfach angefragt wird.
import { eq } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { buechereiTitles } from "@/core/db/schema";
import { defineSetting, readModuleSetting, type ModuleSettingDecl } from "@/core/modules/settings";
import { ForbiddenError, hasPermission, type PermissionSet } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { normalizeIsbn } from "./labels";

// ---------------------------------------------------------------- Quellen

export type IsbnSourceId = "dnb" | "lobid" | "openlibrary";

export interface IsbnSuggestion {
  isbn: string;
  title: string;
  author: string | null;
  publisher: string | null;
  year: number | null;
}

interface IsbnSource {
  id: IsbnSourceId;
  label: string;
  /** Empfänger der Anfrage (für Hinweis, VVT und Firewall-Freigabe) */
  host: string;
  /** Empfänger außerhalb der EU (Drittland) – Quelle ab Werk aus */
  outsideEu?: boolean;
  url: (isbn: string) => string;
  parse: (body: string, isbn: string) => IsbnSuggestion | null;
}

const ON_OFF = [
  { value: "0", label: "aus" },
  { value: "1", label: "an" },
] as const;

/** Hauptschalter (Vorgabe aus) – Datenabfluss nach außen, daher nur mit `verwaltung.privacy` änderbar. */
export const ISBN_LOOKUP = defineSetting({
  key: "buecherei.isbn",
  label: "ISBN-Abfrage bei Bibliothekskatalogen",
  help: "Beim Anlegen eines Titels Angaben zu einer ISBN aus öffentlichen Bibliothekskatalogen vorschlagen. Übertragen wird nur die ISBN, vom Server aus (keine Namen, keine Angaben zur Schule). Braucht ausgehenden Internetzugang (HTTPS); ohne ihn erscheint nur ein Hinweis.",
  options: ON_OFF,
  default: "0",
  permission: "verwaltung.privacy",
});

function sourceSetting(s: { id: IsbnSourceId; label: string; host: string; outsideEu?: boolean }): ModuleSettingDecl {
  return defineSetting({
    key: `buecherei.isbn_${s.id}`,
    label: `ISBN-Quelle: ${s.label}`,
    help: s.outsideEu
      ? `Fragt ${s.host} – ein Dienst außerhalb der EU (die ISBN und die Adresse des Schulservers gehen in ein Drittland). Ab Werk aus, nur nach Prüfung einschalten (nur wenn die ISBN-Abfrage eingeschaltet ist; als letzte Quelle).`
      : `Fragt ${s.host} (nur wenn die ISBN-Abfrage eingeschaltet ist; Quellen der Reihe nach, bis eine etwas findet).`,
    options: ON_OFF,
    // GATE BU1 (datensparsam): ab Werk nur die Kataloge in Deutschland; Quellen außerhalb der EU muss die Schule bewusst zuschalten
    default: s.outsideEu ? "0" : "1",
    permission: "verwaltung.privacy",
  });
}

const clean = (s: string | null | undefined, max: number): string | null => {
  const v = (s ?? "")
    .replace(/[\u0098\u009c]/g, "") // MARC: Nichtsortierzeichen um Artikel
    .replace(/\s+/g, " ")
    .replace(/[\s/:;,.=]+$/, "")
    .trim();
  return v ? v.slice(0, max) : null;
};

/** Rein: „Nachname, Vorname“ → „Vorname Nachname“ (Körperschaften ohne Komma bleiben). */
export function personName(raw: string | null | undefined): string | null {
  const v = clean(raw, 200);
  if (!v) return null;
  const m = /^([^,]+),\s*(.+)$/.exec(v);
  return clean(m ? `${m[2]} ${m[1]}` : v, 120);
}

/** Rein: erste plausible Jahreszahl (1450 … nächstes Jahr). */
export function yearOf(raw: string | null | undefined): number | null {
  const m = /\b(1[4-9]\d\d|20\d\d)\b/.exec(raw ?? "");
  const y = m ? Number(m[1]) : NaN;
  return Number.isInteger(y) && y >= 1450 && y <= new Date().getFullYear() + 1 ? y : null;
}

function joinTitle(main: string | null | undefined, sub: string | null | undefined): string | null {
  const a = clean(main, 200);
  const b = clean(sub, 200);
  return a ? clean(b ? `${a} : ${b}` : a, 200) : null;
}

const decodeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Rein: MARC21-XML (SRU-Antwort) → Felder je Tag mit Unterfeldern; nur der erste Datensatz. */
export function marcFields(xml: string): { tag: string; ind2: string; sub: Record<string, string> }[] {
  const first = /<record[^>]*type="Bibliographic"[^>]*>([\s\S]*?)<\/record>/.exec(xml)?.[1] ?? xml;
  const out: { tag: string; ind2: string; sub: Record<string, string> }[] = [];
  for (const m of first.matchAll(/<datafield\s+tag="(\d{3})"([^>]*)>([\s\S]*?)<\/datafield>/g)) {
    const ind2 = /ind2="(.)"/.exec(m[2] ?? "")?.[1] ?? " ";
    const sub: Record<string, string> = {};
    for (const s of m[3]!.matchAll(/<subfield\s+code="(.)">([\s\S]*?)<\/subfield>/g)) if (!(s[1]! in sub)) sub[s[1]!] = decodeXml(s[2]!);
    out.push({ tag: m[1]!, ind2, sub });
  }
  return out;
}

/** Rein: Nationalbibliothek (SRU, MARC21-XML). */
export function parseDnb(xml: string, isbn: string): IsbnSuggestion | null {
  const n = /<numberOfRecords>(\d+)<\/numberOfRecords>/.exec(xml);
  if (n && Number(n[1]) === 0) return null;
  const f = marcFields(xml);
  const get = (tag: string) => f.find((x) => x.tag === tag);
  const t = get("245");
  const title = joinTitle(t?.sub.a, t?.sub.b);
  if (!title) return null;
  const pub = f.find((x) => x.tag === "264" && x.ind2 === "1") ?? get("264") ?? get("260");
  return {
    isbn,
    title,
    author: personName(get("100")?.sub.a ?? get("700")?.sub.a ?? get("110")?.sub.a),
    publisher: clean(pub?.sub.b, 120),
    year: yearOf(pub?.sub.c),
  };
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? (v[0] as string) : null);
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Rein: Verbundkatalog (JSON-Schnittstelle des Hochschulbibliothekszentrums). */
export function parseLobid(body: string, isbn: string): IsbnSuggestion | null {
  const data = obj(JSON.parse(body));
  const rec = obj(arr(data?.member)[0]);
  if (!rec) return null;
  const title = joinTitle(str(rec.title), str(rec.otherTitleInformation));
  if (!title) return null;
  const contributions = arr(rec.contribution).map(obj).filter((c): c is Json => !!c);
  const author = contributions.map((c) => str(obj(c.agent)?.label)).find(Boolean) ?? null;
  const pub = obj(arr(rec.publication)[0]);
  return { isbn, title, author: personName(author), publisher: clean(str(pub?.publishedBy), 120), year: yearOf(str(pub?.startDate)) };
}

/** Rein: offene Online-Bibliothek (Bücher-Schnittstelle, `jscmd=data`). */
export function parseOpenLibrary(body: string, isbn: string): IsbnSuggestion | null {
  const data = obj(JSON.parse(body));
  const rec = obj(data?.[`ISBN:${isbn}`]) ?? obj(Object.values(data ?? {})[0]);
  if (!rec) return null;
  const title = joinTitle(str(rec.title), str(rec.subtitle));
  if (!title) return null;
  const author = str(obj(arr(rec.authors)[0])?.name);
  const publisher = str(obj(arr(rec.publishers)[0])?.name);
  return { isbn, title, author: clean(author, 120), publisher: clean(publisher, 120), year: yearOf(str(rec.publish_date)) };
}

export const ISBN_SOURCES: readonly IsbnSource[] = [
  {
    id: "dnb",
    label: "Deutsche Nationalbibliothek",
    host: "services.dnb.de",
    url: (isbn) => `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=num%3D${isbn}&recordSchema=MARC21-xml&maximumRecords=1`,
    parse: parseDnb,
  },
  {
    id: "lobid",
    label: "Verbundkatalog des Hochschulbibliothekszentrums NRW",
    host: "lobid.org",
    url: (isbn) => `https://lobid.org/resources/search?q=isbn%3A${isbn}&format=json&size=1`,
    parse: parseLobid,
  },
  {
    id: "openlibrary",
    label: "Open Library",
    host: "openlibrary.org",
    outsideEu: true,
    url: (isbn) => `https://openlibrary.org/api/books?bibkeys=ISBN%3A${isbn}&format=json&jscmd=data`,
    parse: parseOpenLibrary,
  },
];

export const ISBN_SOURCE_SETTINGS: Record<IsbnSourceId, ModuleSettingDecl> = {
  dnb: sourceSetting(ISBN_SOURCES[0]!),
  lobid: sourceSetting(ISBN_SOURCES[1]!),
  openlibrary: sourceSetting(ISBN_SOURCES[2]!),
};

export const ISBN_SETTINGS: readonly ModuleSettingDecl[] = [ISBN_LOOKUP, ...ISBN_SOURCES.map((s) => ISBN_SOURCE_SETTINGS[s.id])];

// ---------------------------------------------------------------- Abfrage

/** Zeitlimit für alle Quellen zusammen. */
export const LOOKUP_BUDGET_MS = 5_000;
/** Größte Antwort, die gelesen wird (Schutz vor übergroßen Antworten). */
export const MAX_RESPONSE_BYTES = 512 * 1024;
const CACHE_HIT_MS = 24 * 60 * 60 * 1000;
const CACHE_MISS_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

export type FetchText = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const cache = new Map<string, { at: number; result: IsbnSuggestion | null; source: IsbnSourceId | null }>();

/** Zwischenspeicher leeren (Tests, Einstellungsänderung). */
export function clearIsbnCache() {
  cache.clear();
}

export type LookupResult =
  | { kind: "found"; suggestion: IsbnSuggestion; source: string; cached: boolean }
  | { kind: "duplicate"; titleId: string; title: string }
  | { kind: "none"; asked: string[] }
  | { kind: "unreachable"; asked: string[] };

/** Ist die ISBN-Abfrage eingeschaltet, und welche Quellen (Reihenfolge) sind aktiv? */
export async function isbnLookupConfig(db: Db): Promise<{ enabled: boolean; sources: { id: IsbnSourceId; label: string; host: string }[] }> {
  const enabled = (await readModuleSetting(db, ISBN_LOOKUP)) === "1";
  const sources: { id: IsbnSourceId; label: string; host: string }[] = [];
  for (const s of ISBN_SOURCES) if ((await readModuleSetting(db, ISBN_SOURCE_SETTINGS[s.id])) === "1") sources.push({ id: s.id, label: s.label, host: s.host });
  return { enabled: enabled && sources.length > 0, sources };
}

/**
 * Titelangaben zu einer ISBN vorschlagen (Recht `buecherei.stock`). Erst die Dublettenprüfung im eigenen Bestand (dann geht
 * nichts nach außen), dann der Zwischenspeicher, dann die eingeschalteten Quellen der Reihe nach, bis eine etwas findet –
 * zusammen höchstens `LOOKUP_BUDGET_MS`. Netzfehler und Zeitüberschreitung → „nicht erreichbar“, nie ein Absturz.
 */
export async function lookupIsbn(
  db: Db,
  viewer: PermissionSet,
  rawIsbn: string,
  opts: { fetchImpl?: FetchText; now?: () => number; budgetMs?: number } = {},
): Promise<LookupResult> {
  if (!hasPermission(viewer, "buecherei.stock")) throw new ForbiddenError("buecherei.stock");
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) throw new ValidationError({ isbn: "keine gültige ISBN (Prüfziffer)" });
  const [dup] = await db.select({ id: buechereiTitles.id, title: buechereiTitles.title }).from(buechereiTitles).where(eq(buechereiTitles.isbn, isbn));
  if (dup) return { kind: "duplicate", titleId: dup.id, title: dup.title };
  const cfg = await isbnLookupConfig(db);
  if (!cfg.enabled) throw new ValidationError({ isbn: "Die ISBN-Abfrage ist ausgeschaltet (Verwaltung → Rechte & Module → Bücherei)" });
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchText);
  const label = (id: IsbnSourceId | null) => ISBN_SOURCES.find((s) => s.id === id)?.label ?? "";

  const hit = cache.get(isbn);
  if (hit && now() - hit.at < (hit.result ? CACHE_HIT_MS : CACHE_MISS_MS)) {
    if (hit.result) return { kind: "found", suggestion: hit.result, source: label(hit.source), cached: true };
    return { kind: "none", asked: cfg.sources.map((s) => s.label) };
  }

  const deadline = now() + (opts.budgetMs ?? LOOKUP_BUDGET_MS);
  const asked: string[] = [];
  let answered = false;
  for (const s of ISBN_SOURCES.filter((x) => cfg.sources.some((c) => c.id === x.id))) {
    const left = deadline - now();
    if (left <= 0) break;
    asked.push(s.label);
    try {
      const res = await fetchImpl(s.url(isbn), {
        signal: AbortSignal.timeout(left),
        // nur die ISBN in der Adresse – keine Cookies, keine Angaben zur Schule
        headers: { Accept: s.id === "dnb" ? "application/xml" : "application/json", "User-Agent": "SchulOS-Buecherei" },
      });
      if (!res.ok) continue;
      const body = await res.text();
      answered = true;
      if (body.length > MAX_RESPONSE_BYTES) continue;
      const suggestion = s.parse(body, isbn);
      if (suggestion) {
        remember(isbn, suggestion, s.id, now());
        return { kind: "found", suggestion, source: s.label, cached: false };
      }
    } catch {
      // Netzfehler, Zeitüberschreitung, unlesbare Antwort → nächste Quelle
    }
  }
  if (!answered) return { kind: "unreachable", asked };
  remember(isbn, null, null, now());
  return { kind: "none", asked };
}

function remember(isbn: string, result: IsbnSuggestion | null, source: IsbnSourceId | null, at: number) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(isbn, { at, result, source });
}
