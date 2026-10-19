// Schulbücherei – ISBN-Abfrage (BU-06): Parser je Quelle, Reihenfolge, Abschalten, Zeitlimit, Zwischenspeicher, Dublette,
// ohne Internet kein Absturz. Keine echten Netzzugriffe – `fetch` ist immer eine Attrappe (SICHERHEIT S78).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { createSeededTestDb } from "@/core/db/testing";
import { writeModuleSetting, type ModuleSettingDecl } from "@/core/modules/settings";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { newTitleFields } from "@/app/(shell)/buecherei/bestand/title-fields";
import { like } from "drizzle-orm";
import { appSettings } from "@/core/db/schema";
import { ISBN_LOOKUP, ISBN_SOURCE_SETTINGS, LOOKUP_BUDGET_MS, clearIsbnCache, isbnLookupConfig, lookupIsbn, parseDnb, parseLobid, parseOpenLibrary, personName, yearOf, type FetchText } from "./isbn";
import { MAX_COPIES_AT_ONCE } from "./service";
import { BUECHEREI_SETTINGS } from "./settings";

const ISBN = "9780306406157"; // 0-306-40615-2
const SABINE = "u-sabine.kowalski";
const JANA = "u-jana.brandt";

const DNB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><version>1.1</version><numberOfRecords>1</numberOfRecords><records><record><recordSchema>MARC21-xml</recordSchema><recordData>
<record xmlns="http://www.loc.gov/MARC21/slim" type="Bibliographic"><leader>00000nam a2200000 c 4500</leader>
<datafield tag="020" ind1=" " ind2=" "><subfield code="a">9780306406157</subfield></datafield>
<datafield tag="100" ind1="1" ind2=" "><subfield code="a">Feld, Mara</subfield><subfield code="4">aut</subfield></datafield>
<datafield tag="245" ind1="1" ind2="0"><subfield code="a">&#152;Die&#156; Nacht im Leuchtturm</subfield><subfield code="b">ein Abenteuer &amp; mehr</subfield><subfield code="c">Mara Feld</subfield></datafield>
<datafield tag="264" ind1=" " ind2="1"><subfield code="a">Musterstadt</subfield><subfield code="b">Lindenblatt</subfield><subfield code="c">[2019]</subfield></datafield>
</record></recordData></record></records></searchRetrieveResponse>`;
const DNB_EMPTY = `<searchRetrieveResponse><numberOfRecords>0</numberOfRecords></searchRetrieveResponse>`;
const LOBID = JSON.stringify({
  totalItems: 1,
  member: [{ title: "Wolkenfänger", otherTitleInformation: ["Roman"], contribution: [{ agent: { label: "Brink, Jonas" } }], publication: [{ startDate: "2021", publishedBy: ["Lindenblatt"] }] }],
});
const LOBID_EMPTY = JSON.stringify({ totalItems: 0, member: [] });
const OPENLIB = JSON.stringify({ [`ISBN:${ISBN}`]: { title: "Atlas", authors: [{ name: "Paul Gerber" }], publishers: [{ name: "Wissenswerk" }], publish_date: "May 3, 2022" } });

type Reply = { status?: number; body?: string; error?: Error; delayMs?: number };

/** Attrappe für `fetch`: Antwort je Host; zeichnet die Aufrufe auf. */
function fakeFetch(replies: Record<string, Reply>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: FetchText = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const host = new URL(url).host;
    const r = replies[host] ?? { error: new TypeError("fetch failed") };
    if (r.delayMs)
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init.signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal.reason);
        });
      });
    if (r.error) throw r.error;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.body ?? "" };
  };
  return { impl, calls };
}

describe("ISBN-Abfrage – rein", () => {
  it("Nationalbibliothek (MARC21-XML): Titel mit Untertitel, Person umgedreht, Verlag, Jahr; MARC-Sortierzeichen weg", () => {
    expect(parseDnb(DNB_XML, ISBN)).toEqual({ isbn: ISBN, title: "Die Nacht im Leuchtturm : ein Abenteuer & mehr", author: "Mara Feld", publisher: "Lindenblatt", year: 2019 });
    expect(parseDnb(DNB_EMPTY, ISBN)).toBeNull();
  });

  it("Verbundkatalog (JSON) und offene Online-Bibliothek", () => {
    expect(parseLobid(LOBID, ISBN)).toEqual({ isbn: ISBN, title: "Wolkenfänger : Roman", author: "Jonas Brink", publisher: "Lindenblatt", year: 2021 });
    expect(parseLobid(LOBID_EMPTY, ISBN)).toBeNull();
    expect(parseOpenLibrary(OPENLIB, ISBN)).toEqual({ isbn: ISBN, title: "Atlas", author: "Paul Gerber", publisher: "Wissenswerk", year: 2022 });
    expect(parseOpenLibrary("{}", ISBN)).toBeNull();
  });

  it("Namen und Jahre", () => {
    expect(personName("Sommer, Ida")).toBe("Ida Sommer");
    expect(personName("Schulamt Musterstadt")).toBe("Schulamt Musterstadt");
    expect(yearOf("c 2020")).toBe(2020);
    expect(yearOf("ohne Jahr")).toBeNull();
    expect(yearOf("3020")).toBeNull();
  });

  it("Einstellungen: Hauptschalter ab Werk aus, nur mit `verwaltung.privacy`; alle im Modul deklariert", () => {
    expect(ISBN_LOOKUP.default).toBe("0");
    expect(ISBN_LOOKUP.permission).toBe("verwaltung.privacy");
    for (const s of Object.values(ISBN_SOURCE_SETTINGS)) expect(s.permission).toBe("verwaltung.privacy");
    // GATE BU1: ab Werk nur die Kataloge in Deutschland; Open Library (außerhalb der EU) muss die Schule bewusst zuschalten
    expect(ISBN_SOURCE_SETTINGS.dnb.default).toBe("1");
    expect(ISBN_SOURCE_SETTINGS.lobid.default).toBe("1");
    expect(ISBN_SOURCE_SETTINGS.openlibrary.default).toBe("0");
    expect(ISBN_SOURCE_SETTINGS.openlibrary.help).toMatch(/außerhalb der EU/);
    const keys = BUECHEREI_SETTINGS.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["buecherei.isbn", "buecherei.isbn_dnb", "buecherei.isbn_lobid", "buecherei.isbn_openlibrary"]));
  });

  it("Formularfelder passen zum Service (Exemplare)", () => {
    expect(newTitleFields().find((f) => f.name === "count")!.max).toBe(MAX_COPIES_AT_ONCE);
  });
});

describe("ISBN-Abfrage", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const set = async (decl: ModuleSettingDecl, v: string) => writeModuleSetting(h.db, decl, v);

  beforeAll(async () => {
    h = await createSeededTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    clearIsbnCache();
    await set(ISBN_LOOKUP, "1");
    for (const s of Object.values(ISBN_SOURCE_SETTINGS)) await set(s, "1");
  });

  it("ab Werk aus: keine Anfrage nach außen", async () => {
    await set(ISBN_LOOKUP, "0");
    const f = fakeFetch({});
    await expect(lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: f.impl })).rejects.toBeInstanceOf(ValidationError);
    expect(f.calls).toHaveLength(0);
  });

  it("GATE BU1: nur der Hauptschalter an → nur die deutschen Kataloge, Open Library (außerhalb der EU) wird nie gefragt", async () => {
    await h.db.delete(appSettings).where(like(appSettings.key, "module.buecherei.isbn\\_%"));
    const cfg = await isbnLookupConfig(h.db);
    expect(cfg.sources.map((s) => s.id)).toEqual(["dnb", "lobid"]);
    const f = fakeFetch({ "services.dnb.de": { body: DNB_EMPTY }, "lobid.org": { body: LOBID_EMPTY }, "openlibrary.org": { body: OPENLIB } });
    expect(await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: f.impl })).toMatchObject({ kind: "none" });
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual(["services.dnb.de", "lobid.org"]);
    // bewusst zugeschaltet: als letzte Quelle
    clearIsbnCache();
    await set(ISBN_SOURCE_SETTINGS.openlibrary, "1");
    const g = fakeFetch({ "services.dnb.de": { body: DNB_EMPTY }, "lobid.org": { body: LOBID_EMPTY }, "openlibrary.org": { body: OPENLIB } });
    expect(await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: g.impl })).toMatchObject({ kind: "found", source: "Open Library" });
    expect(g.calls.map((c) => new URL(c.url).host)).toEqual(["services.dnb.de", "lobid.org", "openlibrary.org"]);
  });

  it("nur mit `buecherei.stock`; ungültige ISBN geht nicht raus", async () => {
    const f = fakeFetch({});
    await expect(lookupIsbn(h.db, await p(JANA), ISBN, { fetchImpl: f.impl })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(lookupIsbn(h.db, await p(SABINE), "978-0-306-40615-8", { fetchImpl: f.impl })).rejects.toBeInstanceOf(ValidationError);
    expect(f.calls).toHaveLength(0);
  });

  it("Dublette im Bestand: Hinweis, keine Anfrage nach außen", async () => {
    const f = fakeFetch({});
    const r = await lookupIsbn(h.db, await p(SABINE), "978-3-00-000001-0", { fetchImpl: f.impl });
    expect(r).toMatchObject({ kind: "duplicate", title: "Die Nacht im Leuchtturm" });
    expect(f.calls).toHaveLength(0);
  });

  it("Quellen der Reihe nach, bis eine etwas findet; nur die ISBN in der Anfrage; danach aus dem Zwischenspeicher", async () => {
    const f = fakeFetch({ "services.dnb.de": { body: DNB_EMPTY }, "lobid.org": { body: LOBID } });
    const r = await lookupIsbn(h.db, await p(SABINE), "0-306-40615-2", { fetchImpl: f.impl });
    expect(r).toMatchObject({ kind: "found", source: "Verbundkatalog des Hochschulbibliothekszentrums NRW", cached: false, suggestion: { title: "Wolkenfänger : Roman" } });
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual(["services.dnb.de", "lobid.org"]);
    for (const c of f.calls) {
      expect(c.url).toContain(ISBN);
      expect(c.url).not.toMatch(/sabine|kowalski|lindenhof/i);
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    }
    const again = await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: f.impl });
    expect(again).toMatchObject({ kind: "found", cached: true });
    expect(f.calls).toHaveLength(2);
  });

  it("einzeln abschaltbar: ausgeschaltete Quelle wird nicht gefragt", async () => {
    await set(ISBN_SOURCE_SETTINGS.dnb, "0");
    await set(ISBN_SOURCE_SETTINGS.lobid, "0");
    const f = fakeFetch({ "openlibrary.org": { body: OPENLIB } });
    const r = await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: f.impl });
    expect(r).toMatchObject({ kind: "found", source: "Open Library" });
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual(["openlibrary.org"]);
    // alle Quellen aus = Abfrage aus
    await set(ISBN_SOURCE_SETTINGS.openlibrary, "0");
    clearIsbnCache();
    await expect(lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: f.impl })).rejects.toBeInstanceOf(ValidationError);
  });

  it("ohne Internet (Schulnetz ohne Außenzugang): „nicht erreichbar“ statt Absturz; nichts gefunden: „keine Treffer“", async () => {
    const off = fakeFetch({}); // jede Anfrage scheitert wie ohne DNS/Route
    expect(await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: off.impl })).toMatchObject({ kind: "unreachable" });
    expect(off.calls).toHaveLength(3);
    const bad = fakeFetch({ "services.dnb.de": { status: 503 }, "lobid.org": { body: "kein JSON" }, "openlibrary.org": { body: "{}" } });
    expect(await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: bad.impl })).toMatchObject({ kind: "none" });
  });

  it("Zeitlimit für alle Quellen zusammen: hängende Quelle wird abgebrochen, danach keine weitere", async () => {
    const slow = fakeFetch({ "services.dnb.de": { delayMs: 10_000, body: DNB_XML }, "lobid.org": { body: LOBID } });
    const started = Date.now();
    const r = await lookupIsbn(h.db, await p(SABINE), ISBN, { fetchImpl: slow.impl, budgetMs: 200 });
    expect(r).toMatchObject({ kind: "unreachable" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow.calls.map((c) => new URL(c.url).host)).toEqual(["services.dnb.de"]);
    expect(LOOKUP_BUDGET_MS).toBe(5_000);
  });
});
