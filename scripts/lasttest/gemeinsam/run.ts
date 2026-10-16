// Lasttest „gemeinsam bearbeiten“ (Gate 3b): N Personen derselben Gruppe öffnen den Live-Strom (SSE) und bearbeiten
// gleichzeitig einen Text (Yjs-Updates per POST, Bündel alle 300 ms wie der Editor) bzw. eine Tafel (Element-Updates per POST,
// Bündel alle 250 ms wie die Tafel) – je Phase einige Minuten. Gemessen: Antwortzeiten der POSTs, Zustellverzögerung bis die
// anderen das Ereignis im SSE-Strom sehen (jedes Ereignis, über die Kennung des gesendeten Bündels), Fehler; am Ende jeder
// Phase der Konsistenzvergleich über den Sync-Endpunkt (alle sehen denselben Stand, und wie viele hatten etwas verpasst).
//
// Warum nicht k6: k6 kann ohne eigene Erweiterung keinen SSE-Strom lesen, und gültige Yjs-Updates braucht ohnehin yjs selbst.
// Läuft mit `npx tsx` auf dem Runner, gestartet von scripts/lasttest.sh (SZENARIO=gemeinsam), Ergebnis als JSON für
// scripts/lasttest-auswertung.ts.
//
// Umgebung: BASE_URL (https://demo.schulos.test), ZIEL_IP (Adresse statt DNS), KONTEN (JSON-Datei {accounts, text, tafel}),
// PERSONEN (30), PHASEN (text,tafel,beide), DAUER (5m je Phase), PASSWORT (schulos), AUSGABE (Ergebnisdatei),
// LASTTEST_ZIEL_OK=1 (nur dann auch gegen ein Ziel, das keine Demo-Instanz ist – G3B-06)
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { monitorEventLoopDelay } from "node:perf_hooks";
import * as Y from "yjs";
import { b64, between, hasStructs, hiddenInputs, istDemoSeite, multipart, parseDuration, rng, sceneDiff, sceneFingerprint, SendBook, SseParser, summarize, TafelDrawer, tafelKey, TextWriter, textKeys, unb64, wins, zielPruefen, type El } from "./lib";

const BASE = new URL(process.env.BASE_URL || "https://demo.schulos.test");
/** http nur für einen lokalen Probelauf gegen `npm start` */
const NET = BASE.protocol === "http:" ? http : https;
const IP = process.env.ZIEL_IP || "";
/** Schreiben nur gegen die Demo-VM bzw. localhost (G3B-06); Zertifikatsprüfung nur dort aus */
const FREIGABE = process.env.LASTTEST_ZIEL_OK === "1";
const ZIEL = zielPruefen(BASE, IP, FREIGABE);
if (!ZIEL.ok) throw new Error(ZIEL.grund);
const PERSONEN = Number(process.env.PERSONEN || 30);
const PHASEN = (process.env.PHASEN || "text,tafel,beide").split(",").map((s) => s.trim()).filter(Boolean);
const DAUER = parseDuration(process.env.DAUER || "5m");
const PASSWORT = process.env.PASSWORT || "schulos";
const AUSGABE = process.env.AUSGABE || "gemeinsam.json";
const TEXT_FLUSH_MS = 300; // texte/[id]/editor.tsx FLUSH_MS
const TAFEL_FLUSH_MS = 250; // tafeln/[id]/board.tsx
const HEARTBEAT_MS = 120_000; // beide Clients: Sync alle 2 Minuten

for (const p of PHASEN) if (!["text", "tafel", "beide"].includes(p)) throw new Error(`Phase „${p}“: text, tafel oder beide`);
const konten = JSON.parse(readFileSync(process.env.KONTEN || "gemeinsam-konten.json", "utf8")) as { accounts: string[]; text: string | null; tafel: string | null };
if (!konten.text || !konten.tafel) throw new Error("Kein Text oder keine Tafel in der Gruppe (KONTEN)");
if (konten.accounts.length < PERSONEN) throw new Error(`Nur ${konten.accounts.length} Konten in der Gruppe, gebraucht ${PERSONEN}`);

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();
const epoch = () => Math.round(Date.now() / 1000);

// ---------------------------------------------------------------- HTTP

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

class Client {
  readonly agent = BASE.protocol === "http:" ? new http.Agent({ keepAlive: true, maxSockets: 4 }) : new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: ZIEL.tlsPruefen });
  readonly cookies = new Map<string, string>();

  private options(method: string, path: string, headers: Record<string, string>) {
    return {
      method,
      host: IP || BASE.hostname,
      port: BASE.port || (BASE.protocol === "http:" ? 80 : 443),
      servername: BASE.hostname,
      path,
      agent: this.agent,
      rejectUnauthorized: ZIEL.tlsPruefen,
      headers: { host: BASE.host, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
    };
  }

  private remember(h: Res["headers"]) {
    const set = h["set-cookie"];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }

  request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const req = NET.request(this.options(method, path, body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) }), (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          this.remember(res.headers);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      });
      req.setTimeout(30_000, () => req.destroy(new Error("Zeitüberschreitung")));
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  json(path: string, payload: unknown): Promise<Res> {
    return this.request("POST", path, JSON.stringify(payload), { "content-type": "application/json" });
  }

  /** SSE-Strom: Ereignisse an `onEvent`, Ende/Fehler an `onEnd` */
  stream(path: string, onEvent: (event: string, data: string) => void, onEnd: (why: string) => void): void {
    const req = NET.request(this.options("GET", path, { accept: "text/event-stream" }), (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        onEnd(`HTTP ${res.statusCode}`);
        return;
      }
      const parser = new SseParser();
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const e of parser.push(chunk)) onEvent(e.event, e.data);
      });
      res.on("end", () => onEnd("Ende"));
      res.on("error", (e) => onEnd(String(e)));
    });
    req.on("error", (e) => onEnd(String(e)));
    req.end();
  }
}

// ---------------------------------------------------------------- Messwerte je Phase und Art

class KindStats {
  posts: number[] = [];
  postStatus: Record<string, number> = {};
  syncs: number[] = [];
  syncFailed = 0;
  delivery: number[] = [];
  events = 0;
  eventBytes = 0;
  sentBytes = 0;
  untracked = 0;
  maxEditors = 0;
  crowded = false;
  konsistenz: Record<string, unknown> = {};

  post(ms: number, status: number) {
    this.posts.push(ms);
    this.postStatus[status] = (this.postStatus[status] ?? 0) + 1;
  }

  result() {
    const failed = Object.entries(this.postStatus).reduce((n, [s, c]) => n + (Number(s) >= 200 && Number(s) < 300 ? 0 : c), 0);
    return {
      posts: { ...summarize(this.posts), failed, status: this.postStatus },
      syncs: { ...summarize(this.syncs), failed: this.syncFailed },
      delivery: summarize(this.delivery),
      events: this.events,
      eventBytes: this.eventBytes,
      sentBytes: this.sentBytes,
      untracked: this.untracked,
      maxEditors: this.maxEditors,
      crowded: this.crowded,
      konsistenz: this.konsistenz,
    };
  }
}

interface Phase {
  name: string;
  start: number;
  end: number;
  text?: KindStats;
  tafel?: KindStats;
  generator?: { cpuPercent: number; loopDelayP99Ms: number; loopDelayMaxMs: number };
}

const phases: Phase[] = [];
let current: Phase | null = null;
const textBook = new SendBook();
const tafelBook = new SendBook();
const sse = { reconnects: 0, errors: [] as string[] };

// ---------------------------------------------------------------- Personen

interface Person {
  idx: number;
  username: string;
  http: Client;
  text: TextWriter;
  tafel: TafelDrawer;
  streaming: boolean;
  /** beim Neuaufbau des Stroms: Sync wie der Browser (live-open) */
  onReconnect: (() => void)[];
}

async function login(p: Person): Promise<boolean> {
  const page = await p.http.request("GET", "/login");
  const fields = hiddenInputs(page.body);
  fields.username = p.username;
  fields.password = PASSWORT;
  const { body, type } = multipart(fields);
  const res = await p.http.request("POST", "/login", body, { "content-type": type, origin: BASE.origin });
  return res.status === 303 && [...p.http.cookies.keys()].some((k) => k.includes("session_token"));
}

function onLive(p: Person, event: string, data: string) {
  if (event !== "text" && event !== "tafel") return;
  const at = now();
  const st = current?.[event];
  const m = JSON.parse(data) as { docId?: string; boardId?: string; update?: string; elements?: El[] };
  if (event === "text" && m.docId === konten.text && m.update) {
    const u = unb64(m.update);
    if (st) {
      st.events++;
      st.eventBytes += data.length;
      for (const k of textKeys(u)) {
        const d = textBook.delay(k, p.idx, at);
        if (d !== null) st.delivery.push(d);
      }
    }
    p.text.applyRemote(u);
  } else if (event === "tafel" && m.boardId === konten.tafel && m.elements) {
    if (st) {
      st.events++;
      st.eventBytes += data.length;
      for (const el of m.elements) {
        const d = tafelBook.delay(tafelKey(el), p.idx, at);
        if (d !== null) st.delivery.push(d);
      }
    }
    p.tafel.applyRemote(m.elements);
  }
}

function openStream(p: Person): Promise<void> {
  return new Promise((ready) => {
    let first = true;
    const connect = () =>
      p.http.stream(
        "/api/gong/stream",
        (event, data) => {
          if (event === "hello") {
            p.streaming = true;
            if (first) {
              first = false;
              ready();
            } else for (const f of p.onReconnect) f();
            return;
          }
          onLive(p, event, data);
        },
        (why) => {
          p.streaming = false;
          if (stopping) return;
          sse.reconnects++;
          if (sse.errors.length < 20) sse.errors.push(`${p.username}: ${why}`);
          setTimeout(connect, 1000);
        },
      );
    connect();
  });
}

let stopping = false;

// ---------------------------------------------------------------- Text

async function textSync(p: Person, st: KindStats, push = true): Promise<void> {
  const t0 = now();
  try {
    const res = await p.http.json(`/api/texte/${konten.text}/sync`, { sv: b64(Y.encodeStateVector(p.text.doc)) });
    st.syncs.push(now() - t0);
    if (res.status !== 200) {
      st.syncFailed++;
      return;
    }
    const j = JSON.parse(res.body) as { update: string; sv: string; editors: number; crowded: boolean };
    p.text.applyRemote(unb64(j.update));
    st.maxEditors = Math.max(st.maxEditors, j.editors);
    st.crowded ||= j.crowded;
    if (push) {
      const missing = Y.encodeStateAsUpdate(p.text.doc, unb64(j.sv));
      if (hasStructs(missing)) p.text.requeue(missing);
    }
  } catch {
    st.syncs.push(now() - t0);
    st.syncFailed++;
  }
}

/** Sendelogik wie der Editor: gesammelt, höchstens ein POST unterwegs, bei Fehlern Backoff bis 10 s */
function textOutbox(p: Person, st: KindStats) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let backoff = TEXT_FLUSH_MS;
  const schedule = (ms: number) => {
    if (timer || inflight) return;
    timer = setTimeout(() => {
      timer = null;
      inflight = flush().finally(() => {
        inflight = null;
        if (p.text.pending) schedule(backoff);
      });
    }, ms);
  };
  const flush = async () => {
    const batch = p.text.takeBatch();
    if (!batch) return;
    const body = { update: b64(batch.update) };
    st.sentBytes += body.update.length;
    const t0 = now();
    if (batch.key) textBook.note(batch.key, p.idx, t0);
    else st.untracked++;
    try {
      const res = await p.http.json(`/api/texte/${konten.text}/update`, body);
      st.post(now() - t0, res.status);
      if (res.status === 200) {
        const j = JSON.parse(res.body) as { editors: number; crowded: boolean };
        st.maxEditors = Math.max(st.maxEditors, j.editors);
        st.crowded ||= j.crowded;
        backoff = TEXT_FLUSH_MS;
      } else if (res.status >= 500 || res.status === 429) {
        p.text.requeue(batch.update);
        backoff = Math.min(backoff * 2, 10_000);
      }
    } catch {
      st.post(now() - t0, 0);
      p.text.requeue(batch.update);
      backoff = Math.min(backoff * 2, 10_000);
    }
  };
  return {
    kick: () => schedule(TEXT_FLUSH_MS),
    drain: async () => {
      for (let i = 0; i < 100 && (p.text.pending || timer || inflight); i++) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (inflight) await inflight;
        if (p.text.pending) {
          inflight = flush().finally(() => (inflight = null));
          await inflight;
        }
      }
    },
  };
}

async function textPerson(p: Person, st: KindStats, until: number, seed: number): Promise<void> {
  const r = rng(seed);
  const out = textOutbox(p, st);
  const resync = () => void textSync(p, st).then(out.kick);
  p.onReconnect.push(resync);
  await textSync(p, st);
  out.kick();
  const beat = setInterval(resync, HEARTBEAT_MS);
  await sleep(between(r, 0, 5000)); // nicht alle in derselben Millisekunde
  while (now() < until) {
    // Schreibphase: 5–20 s mit 2–5 Zeichen/s, dann 3–15 s lesen/überlegen
    const end = Math.min(until, now() + between(r, 5000, 20_000));
    const cps = between(r, 2, 5);
    while (now() < end) {
      p.text.type();
      out.kick();
      await sleep((1000 / cps) * between(r, 0.4, 1.6));
    }
    await sleep(Math.min(until - now(), between(r, 3000, 15_000)));
  }
  clearInterval(beat);
  p.onReconnect.splice(p.onReconnect.indexOf(resync), 1);
  await out.drain();
}

async function textConsistency(people: Person[], st: KindStats) {
  const before = people.map((p) => p.text.content());
  let missed = 0;
  for (const [i, p] of people.entries()) {
    await textSync(p, st, false);
    if (p.text.content() !== before[i]) missed++;
  }
  // Stand des Servers (leerer Zustandsvektor = voller Stand) – über die erste Person
  const res = await people[0]!.http.json(`/api/texte/${konten.text}/sync`, {});
  const server = new Y.Doc();
  if (res.status === 200) Y.applyUpdate(server, unb64((JSON.parse(res.body) as { update: string }).update));
  const serverContent = server.getXmlFragment("default").toString();
  const equal = people.filter((p) => p.text.content() === serverContent).length;
  st.konsistenz = {
    personen: people.length,
    gleich: equal,
    verpasst: missed,
    zeichen: server.getXmlFragment("default").toString().replace(/<[^>]+>/g, "").length,
    absaetze: server.getXmlFragment("default").length,
    standBytes: Y.encodeStateAsUpdate(server).length,
  };
}

// ---------------------------------------------------------------- Tafel

async function tafelSync(p: Person, st: KindStats, push = true): Promise<El[] | null> {
  const t0 = now();
  try {
    const res = await p.http.json(`/api/tafeln/${konten.tafel}/sync`, {});
    st.syncs.push(now() - t0);
    if (res.status !== 200) {
      st.syncFailed++;
      return null;
    }
    const j = JSON.parse(res.body) as { elements: El[]; editors: number; crowded: boolean };
    st.maxEditors = Math.max(st.maxEditors, j.editors);
    st.crowded ||= j.crowded;
    p.tafel.applyRemote(j.elements);
    if (push) {
      // was bei uns neuer ist als beim Server (verlorener POST) – zurück in die Warteschlange
      const server = new Map(j.elements.map((e) => [e.id, e]));
      const newer = [...p.tafel.view.values()].filter((e) => {
        const s = server.get(e.id);
        return s ? wins(e, s) : !e.isDeleted;
      });
      p.tafel.requeue(newer);
    }
    return j.elements;
  } catch {
    st.syncs.push(now() - t0);
    st.syncFailed++;
    return null;
  }
}

function tafelOutbox(p: Person, st: KindStats) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let backoff = TAFEL_FLUSH_MS;
  const schedule = (ms: number) => {
    if (timer || inflight) return;
    timer = setTimeout(() => {
      timer = null;
      inflight = flush().finally(() => {
        inflight = null;
        if (p.tafel.pending) schedule(backoff);
      });
    }, ms);
  };
  const flush = async () => {
    const bundle = p.tafel.takeBundle();
    if (!bundle) return;
    const body = JSON.stringify({ elements: bundle.elements });
    st.sentBytes += body.length;
    const t0 = now();
    for (const k of bundle.keys) tafelBook.note(k, p.idx, t0);
    try {
      const res = await p.http.request("POST", `/api/tafeln/${konten.tafel}/update`, body, { "content-type": "application/json" });
      st.post(now() - t0, res.status);
      if (res.status === 200) {
        const j = JSON.parse(res.body) as { editors: number; crowded: boolean };
        st.maxEditors = Math.max(st.maxEditors, j.editors);
        st.crowded ||= j.crowded;
        backoff = TAFEL_FLUSH_MS;
      } else if (res.status >= 500 || res.status === 429) {
        p.tafel.requeue(bundle.elements);
        backoff = Math.min(backoff * 2, 10_000);
      }
    } catch {
      st.post(now() - t0, 0);
      p.tafel.requeue(bundle.elements);
      backoff = Math.min(backoff * 2, 10_000);
    }
  };
  return {
    kick: () => schedule(TAFEL_FLUSH_MS),
    drain: async () => {
      for (let i = 0; i < 100 && (p.tafel.pending || timer || inflight); i++) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (inflight) await inflight;
        if (p.tafel.pending) {
          inflight = flush().finally(() => (inflight = null));
          await inflight;
        }
      }
    },
  };
}

async function tafelPerson(p: Person, st: KindStats, until: number): Promise<void> {
  const out = tafelOutbox(p, st);
  const resync = () => void tafelSync(p, st).then(out.kick);
  p.onReconnect.push(resync);
  await tafelSync(p, st);
  const beat = setInterval(resync, HEARTBEAT_MS);
  await sleep(between(Math.random, 0, 3000));
  let last = now();
  while (now() < until) {
    await sleep(50);
    const t = now();
    p.tafel.step(t, t - last);
    last = t;
    if (p.tafel.pending) out.kick();
  }
  clearInterval(beat);
  p.onReconnect.splice(p.onReconnect.indexOf(resync), 1);
  await out.drain();
}

async function tafelConsistency(people: Person[], st: KindStats) {
  let missed = 0;
  let missedElements = 0;
  const prints = new Set<string>();
  let equal = 0;
  let elements = 0;
  let live = 0;
  for (const p of people) {
    const before = new Map(p.tafel.view);
    const server = await tafelSync(p, st, false);
    if (!server) continue;
    const serverMap = new Map(server.map((e) => [e.id, e]));
    const d = sceneDiff(before, serverMap);
    if (d > 0) {
      missed++;
      missedElements += d;
    }
    const print = sceneFingerprint(server);
    prints.add(print);
    if (sceneFingerprint(p.tafel.view.values()) === print) equal++;
    elements = server.length;
    live = server.filter((e) => !e.isDeleted).length;
  }
  st.konsistenz = { personen: people.length, gleich: equal, serverStaende: prints.size, verpasst: missed, verpassteElemente: missedElements, elemente: elements, sichtbar: live };
}

// ---------------------------------------------------------------- Ablauf

async function main() {
  const people: Person[] = konten.accounts.slice(0, PERSONEN).map((username, idx) => ({
    idx,
    username,
    http: new Client(),
    text: new TextWriter(rng(1000 + idx)),
    tafel: new TafelDrawer(idx, rng(2000 + idx)),
    streaming: false,
    onReconnect: [],
  }));
  log(`${people.length} Personen, Text ${konten.text}, Tafel ${konten.tafel}, Phasen ${PHASEN.join(", ")} je ${DAUER / 1000} s`);
  // zweite Sperre (G3B-06): die Instanz selbst muss sich als Demo zeigen (Demo-Band auf der Anmeldeseite)
  const probe = await new Client().request("GET", "/login");
  if (!istDemoSeite(probe.body)) {
    if (!FREIGABE) throw new Error(`${BASE.origin} zeigt kein Demo-Band (HTTP ${probe.status}) – keine Demo-Instanz, Abbruch vor dem ersten Schreiben (LASTTEST_ZIEL_OK=1 übersteuert)`);
    log("Achtung: Ziel ist keine Demo-Instanz – Lauf per LASTTEST_ZIEL_OK=1 freigegeben");
  }

  const logins: number[] = [];
  let failedLogins = 0;
  for (let i = 0; i < people.length; i += 5) {
    await Promise.all(
      people.slice(i, i + 5).map(async (p) => {
        const t0 = now();
        const ok = await login(p).catch(() => false);
        logins.push(now() - t0);
        if (!ok) failedLogins++;
      }),
    );
  }
  log(`Anmeldung: ${people.length - failedLogins} ok, ${failedLogins} fehlgeschlagen`);
  if (failedLogins > 0) throw new Error(`${failedLogins} Anmeldungen fehlgeschlagen – ohne alle Personen ist der Lauf nicht aussagekräftig`);

  await Promise.race([Promise.all(people.map(openStream)), sleep(60_000).then(() => Promise.reject(new Error("Live-Strom nicht bei allen offen")))]);
  log("Live-Strom bei allen offen");
  // Zugriff vorab prüfen (Mitglied, Modul an) – sonst misst der Lauf nur Fehler
  for (const p of people) {
    const t = await p.http.json(`/api/texte/${konten.text}/sync`, {});
    const b = await p.http.json(`/api/tafeln/${konten.tafel}/sync`, {});
    if (t.status !== 200 || b.status !== 200) throw new Error(`${p.username}: Text ${t.status} ${t.body.slice(0, 100)}, Tafel ${b.status} ${b.body.slice(0, 100)}`);
  }

  for (const [n, name] of PHASEN.entries()) {
    const phase: Phase = { name, start: epoch(), end: 0 };
    if (name !== "tafel") phase.text = new KindStats();
    if (name !== "text") phase.tafel = new KindStats();
    phases.push(phase);
    current = phase;
    const cpu0 = process.cpuUsage();
    const t0 = now();
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    log(`Phase ${name}: ${DAUER / 1000} s`);
    const until = now() + DAUER;
    await Promise.all(
      people.flatMap((p) => [
        ...(phase.text ? [textPerson(p, phase.text, until, 5000 + n * 100 + p.idx)] : []),
        ...(phase.tafel ? [tafelPerson(p, phase.tafel, until)] : []),
      ]),
    );
    lag.disable();
    const cpu = process.cpuUsage(cpu0);
    phase.generator = { cpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / (now() - t0)) * 100), loopDelayP99Ms: Math.round(lag.percentile(99) / 1e6), loopDelayMaxMs: Math.round(lag.max / 1e6) };
    // ruhen lassen: letzte Ereignisse zustellen, Speichern abwarten (≤ 2 s)
    await sleep(5000);
    phase.end = epoch();
    if (phase.text) await textConsistency(people, phase.text);
    if (phase.tafel) await tafelConsistency(people, phase.tafel);
    log(`Phase ${name} fertig: ${JSON.stringify({ text: phase.text?.konsistenz, tafel: phase.tafel?.konsistenz })}`);
    current = null;
    await sleep(15_000);
  }
  stopping = true;

  const result = {
    personen: people.length,
    dauerMs: DAUER,
    anmeldung: { ...summarize(logins), failed: failedLogins },
    sse: { reconnects: sse.reconnects, fehler: sse.errors },
    phasen: phases.map((p) => ({ name: p.name, start: p.start, end: p.end, generator: p.generator, text: p.text?.result(), tafel: p.tafel?.result() })),
  };
  writeFileSync(AUSGABE, JSON.stringify(result, null, 1));
  for (const p of result.phasen) {
    for (const k of ["text", "tafel"] as const) {
      const s = p[k];
      if (s) log(`${p.name}/${k}: ${s.posts.count} POSTs p95 ${s.posts.p95} ms (Fehler ${s.posts.failed}), Zustellung p95 ${s.delivery.p95} ms (${s.delivery.count}), Konsistenz ${JSON.stringify(s.konsistenz)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`FEHLER: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
