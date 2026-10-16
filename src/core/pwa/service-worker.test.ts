import { describe, expect, it } from "vitest";
import { NO_STORE_PREFIXES } from "@/core/no-store";
import { PWA_CACHE_PREFIX, serviceWorkerSource } from "./service-worker";

// P4-73: Der ausgelieferte Quelltext des Service Workers wird hier mit nachgebauten Browser-Schnittstellen ausgeführt –
// geprüft wird also genau der Code, der im Browser läuft (Cache-Regeln, Q-5A-8).

const ORIGIN = "https://schule.example";

type Handler = (event: unknown) => void;

class FakeCache {
  store = new Map<string, Response>();
  async match(req: Request) {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res);
  }
}

class FakeCaches {
  map = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.map.has(name)) this.map.set(name, new FakeCache());
    return this.map.get(name)!;
  }
  async keys() {
    return [...this.map.keys()];
  }
  async delete(name: string) {
    return this.map.delete(name);
  }
}

/** Antwort mit `type`, wie sie der Browser liefert (in Node ist `type` sonst „default“). */
function response(body: string, init: ResponseInit & { type?: ResponseType } = {}): Response {
  const r = new Response(body, init);
  Object.defineProperty(r, "type", { value: init.type ?? "basic" });
  return r;
}

function load(
  version = "build-1",
  fetchImpl: (req: Request) => Promise<Response> = async () => response("ok", { headers: { "cache-control": "public, max-age=31536000, immutable" } }),
) {
  const handlers = new Map<string, Handler>();
  const caches = new FakeCaches();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, h: Handler) => handlers.set(type, h),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const api = new Function("self", "caches", "fetch", "Response", `${serviceWorkerSource(version)}\nreturn { decide, storable, CACHE };`)(
    self,
    caches,
    fetchImpl,
    Response,
  ) as {
    decide: (req: { url: string; method: string; mode: string; headers: Headers }) => string;
    storable: (res: Response) => boolean;
    CACHE: string;
  };
  /** Fetch-Ereignis auslösen; liefert die Antwort aus respondWith oder null (nicht angefasst = nur Netzwerk). */
  async function dispatch(url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}): Promise<Response | null> {
    let responded: Promise<Response> | null = null;
    const request = Object.assign(new Request(url, { method: init.method ?? "GET", headers: init.headers }), {});
    Object.defineProperty(request, "mode", { value: init.mode ?? "cors" });
    handlers.get("fetch")!({ request, respondWith: (p: Promise<Response>) => (responded = Promise.resolve(p)) });
    return responded ? await responded : null;
  }
  async function cachedUrls(): Promise<string[]> {
    const out: string[] = [];
    for (const c of caches.map.values()) out.push(...c.store.keys());
    return out;
  }
  return { api, handlers, caches, dispatch, cachedUrls };
}

const req = (path: string, opts: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {}) => ({
  url: `${opts.origin ?? ORIGIN}${path}`,
  method: opts.method ?? "GET",
  mode: opts.mode ?? "cors",
  headers: new Headers(opts.headers),
});

describe("P4-73: Service Worker – Cache-Regeln", () => {
  it("cacht nur statische Programmdateien; Seiten gehen ans Netz", () => {
    const { api } = load();
    expect(api.decide(req("/_next/static/chunks/app/page-abc123.js"))).toBe("static");
    expect(api.decide(req("/_next/static/css/5113f39a.css"))).toBe("static");
    expect(api.decide(req("/icon.png"))).toBe("static");
    expect(api.decide(req("/", { mode: "navigate" }))).toBe("navigate");
    expect(api.decide(req("/stundenplan", { mode: "navigate" }))).toBe("navigate");
    // alles andere: nicht anfassen (Bilder aus der App, Logo, Profilbilder, Dateien …)
    for (const p of ["/stundenplan", "/api/schule/logo?v=1", "/api/profilbild/u1", "/manifest.webmanifest", "/sw.js", "/_next/image?url=x"])
      expect(api.decide(req(p))).toBe("network");
  });

  it("Q-5A-8: Pfade der no-store-Liste nie anfassen – weder Seiten noch Abrufe noch Unterpfade", () => {
    const { api } = load();
    for (const prefix of NO_STORE_PREFIXES) {
      for (const p of [prefix, `${prefix}/`, `${prefix}/abc`, `${prefix}/abc?x=1`]) {
        expect(api.decide(req(p)), p).toBe("network");
        expect(api.decide(req(p, { mode: "navigate" })), p).toBe("network");
      }
    }
    // /notenbuchx gehört nicht dazu (wie noStorePath)
    expect(api.decide(req("/notenbuchx", { mode: "navigate" }))).toBe("navigate");
  });

  it("nie: API, Server Actions, RSC-Abrufe, andere Methoden, fremde Herkunft", () => {
    const { api } = load();
    expect(api.decide(req("/api/gong/stream"))).toBe("network");
    expect(api.decide(req("/api", { mode: "navigate" }))).toBe("network");
    expect(api.decide(req("/", { method: "POST", mode: "navigate" }))).toBe("network");
    expect(api.decide(req("/stundenplan", { headers: { "next-action": "abc" } }))).toBe("network");
    expect(api.decide(req("/stundenplan", { headers: { rsc: "1" } }))).toBe("network");
    expect(api.decide(req("/stundenplan?_rsc=x1y2"))).toBe("network");
    expect(api.decide(req("/stundenplan", { mode: "navigate", headers: { rsc: "1" } }))).toBe("network");
    expect(api.decide(req("/_next/static/x.js", { origin: "https://fremd.example" }))).toBe("network");
    expect(api.decide(req("/_next/static/x.js", { method: "POST" }))).toBe("network");
  });

  it("legt nur vollständige, öffentlich cachebare Antworten ab", () => {
    const { api } = load();
    expect(api.storable(response("x", { headers: { "cache-control": "public, max-age=31536000, immutable" } }))).toBe(true);
    expect(api.storable(response("x"))).toBe(true);
    expect(api.storable(response("x", { headers: { "cache-control": "private, no-store, max-age=0" } }))).toBe(false);
    expect(api.storable(response("x", { headers: { "cache-control": "private, max-age=60" } }))).toBe(false);
    expect(api.storable(response("x", { status: 404 }))).toBe(false);
    expect(api.storable(response("x", { status: 206 }))).toBe(false);
    expect(api.storable(response("x", { type: "opaque" }))).toBe(false);
    expect(api.storable(null as unknown as Response)).toBe(false);
  });

  it("Ablauf: statische Datei landet im Cache, Notenbuch/API/Seiten nie; offline kommt der Hinweis ohne Inhalte", async () => {
    let online = true;
    const sw = load("b1", async (r) => {
      if (!online) throw new TypeError("Failed to fetch");
      return response(`antwort ${r.url}`, {
        headers: { "cache-control": r.url.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "private, no-store" },
      });
    });
    expect(await sw.dispatch(`${ORIGIN}/notenbuch/b1`, { mode: "navigate" })).toBeNull();
    expect(await sw.dispatch(`${ORIGIN}/api/notenbuch/b1/sync`)).toBeNull();
    expect(await sw.dispatch(`${ORIGIN}/api/gong`)).toBeNull();
    const page = await sw.dispatch(`${ORIGIN}/stundenplan`, { mode: "navigate" });
    expect(await page!.text()).toContain("antwort");
    const js = await sw.dispatch(`${ORIGIN}/_next/static/chunks/app/(shell)/notenbuch/page-1.js`);
    expect(await js!.text()).toContain("antwort");
    expect(await sw.cachedUrls()).toEqual([`${ORIGIN}/_next/static/chunks/app/(shell)/notenbuch/page-1.js`]);

    online = false;
    // statische Datei aus dem Cache, Seite → Hinweis (503, keine Skripte, nicht cachebar)
    expect(await (await sw.dispatch(`${ORIGIN}/_next/static/chunks/app/(shell)/notenbuch/page-1.js`))!.text()).toContain("antwort");
    const off = (await sw.dispatch(`${ORIGIN}/stundenplan`, { mode: "navigate" }))!;
    expect(off.status).toBe(503);
    expect(off.headers.get("cache-control")).toBe("no-store");
    const html = await off.text();
    expect(html).toContain("Keine Verbindung");
    expect(html).not.toContain("<script");
    // Notenbuch offline: nicht angefasst (Browser zeigt seinen eigenen Fehler, der Service Worker liefert nichts)
    expect(await sw.dispatch(`${ORIGIN}/notenbuch`, { mode: "navigate" })).toBeNull();
    expect(await sw.cachedUrls()).toHaveLength(1);
  });

  it("neue Fassung räumt alte Caches weg, „clear“ (Abmelden) leert alle SchulOS-Caches", async () => {
    const sw = load("b2");
    await sw.caches.open(`${PWA_CACHE_PREFIX}static-b1`);
    await sw.caches.open("fremder-cache");
    await sw.dispatch(`${ORIGIN}/_next/static/a.js`);
    let waited: Promise<unknown> = Promise.resolve();
    sw.handlers.get("activate")!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect((await sw.caches.keys()).sort()).toEqual(["fremder-cache", sw.api.CACHE].sort());
    expect(sw.api.CACHE).toBe(`${PWA_CACHE_PREFIX}static-b2`);
    sw.handlers.get("message")!({ data: { type: "clear" }, waitUntil: (p: Promise<unknown>) => (waited = p) });
    await waited;
    expect(await sw.caches.keys()).toEqual(["fremder-cache"]);
  });

  it("Version landet nur als Text im Quelltext", () => {
    const src = serviceWorkerSource('x";alert(1)//');
    expect(src).toContain('"static-" + "x\\";alert(1)//"');
  });
});
