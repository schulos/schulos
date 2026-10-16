import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { sanitizeElement } from "@/modules/tafeln/scene";
import { hiddenInputs, istDemoSeite, parseDuration, rng, sceneDiff, sceneFingerprint, SendBook, SseParser, summarize, TafelDrawer, tafelKey, TextWriter, textKeys, wins, zielPruefen, type El } from "./lib";

describe("Lasttest gemeinsam – Bausteine", () => {
  it("zerlegt den SSE-Strom auch über Stückgrenzen, ohne Kommentare", () => {
    const p = new SseParser();
    expect(p.push('event: hello\ndata: {"unread":0}\n\n: ping\n\nevent: te')).toEqual([{ event: "hello", data: '{"unread":0}' }]);
    expect(p.push('xt\r\ndata: {"a":\r\ndata: 1}\r\n\r\n')).toEqual([{ event: "text", data: '{"a":\n1}' }]);
    expect(p.push(": ping\n\n")).toEqual([]);
  });

  it("Perzentile nach Rang, leere Liste ergibt Nullen", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toMatchObject({ count: 100, p50: 50, p95: 95, p99: 99, max: 100, avg: 50.5 });
    expect(summarize([])).toMatchObject({ count: 0, p95: 0 });
    expect(summarize([7]).p99).toBe(7);
  });

  it("Zustellverzögerung nur für andere und bekannte Kennungen", () => {
    const b = new SendBook();
    b.note("k", 1, 100);
    expect(b.delay("k", 2, 160)).toBe(60);
    expect(b.delay("k", 1, 160)).toBeNull();
    expect(b.delay("x", 2, 160)).toBeNull();
  });

  it("Schreibende erzeugen gültige Yjs-Updates; die Kennung des Bündels findet sich im verteilten Update wieder", () => {
    // Server wie texte/live.ts: wendet an, verteilt das tatsächlich Neue an alle
    const server = new Y.Doc();
    const writers = [0, 1, 2].map((i) => new TextWriter(rng(i + 1)));
    const sent = new Set<string>();
    const received: string[] = [];
    for (let round = 0; round < 200; round++) {
      for (const w of writers) {
        for (let k = 0; k < 3; k++) w.type();
        const batch = w.takeBatch();
        if (!batch) continue;
        if (batch.key) sent.add(batch.key);
        let effective: Uint8Array | null = null;
        const on = (u: Uint8Array) => (effective = u);
        server.on("update", on);
        Y.applyUpdate(server, batch.update, "client");
        server.off("update", on);
        if (!effective) continue;
        received.push(...textKeys(effective));
        for (const other of writers) other.applyRemote(effective);
      }
    }
    expect(sent.size).toBeGreaterThan(400);
    expect(received.filter((k) => sent.has(k)).length).toBe(sent.size);
    const content = server.getXmlFragment("default").toString();
    expect(content).toContain("<paragraph>");
    for (const w of writers) expect(w.content()).toBe(content);
    // ein Absatz je Person, gelegentlich ein neuer
    expect(server.getXmlFragment("default").length).toBeGreaterThanOrEqual(3);
  });

  it("Zeichnende erzeugen Elemente, die der Server annimmt, bleiben in der Größe begrenzt und kommen zum selben Stand", () => {
    const server = new Map<string, El>();
    const drawers = [0, 1, 2, 3].map((i) => new TafelDrawer(i, rng(10 + i), 5));
    const keys = new Set<string>();
    let bundles = 0;
    for (let t = 0; t <= 120_250; t += 50) {
      for (const d of drawers) {
        if (t <= 120_000) d.step(t, 50);
        if (t % 250 !== 0) continue;
        const b = d.takeBundle();
        if (!b) continue;
        bundles++;
        b.keys.forEach((k) => keys.add(k));
        const changed: El[] = [];
        for (const raw of b.elements) {
          const el = sanitizeElement(JSON.parse(JSON.stringify(raw)));
          expect(el, JSON.stringify(raw).slice(0, 200)).not.toBeNull();
          const cur = server.get(el!.id);
          if (!cur && el!.isDeleted) continue;
          if (wins(el!, cur)) {
            server.set(el!.id, el! as El);
            changed.push(el! as El);
          }
        }
        for (const o of drawers) o.applyRemote(changed);
      }
    }
    expect(bundles).toBeGreaterThan(500);
    expect(keys.has(tafelKey({ id: "last-0-1", version: 1 }))).toBe(true);
    const live = [...server.values()].filter((e) => !e.isDeleted);
    expect(live.length).toBeLessThanOrEqual(4 * 6);
    expect(JSON.stringify([...server.values()]).length).toBeLessThan(4 * 1024 * 1024);
    for (const d of drawers) {
      expect(sceneDiff(d.view, server)).toBe(0);
      expect(sceneFingerprint(d.view.values())).toBe(sceneFingerprint(server.values()));
    }
  });

  it("liest versteckte Formularfelder (Server Action ohne JavaScript) mit Entitäten", () => {
    const html = `<form><input type="hidden" name="$ACTION_REF_1"/><input name="$ACTION_1:0" type="hidden" value="{&quot;id&quot;:&quot;abc&quot;}"><input type="text" name="username" value="x"></form>`;
    expect(hiddenInputs(html)).toEqual({ $ACTION_REF_1: "", "$ACTION_1:0": '{"id":"abc"}' });
  });

  it("G3B-06: schreibt nur gegen die Demo-VM bzw. localhost, sonst nur mit LASTTEST_ZIEL_OK=1; TLS-Prüfung nur dort aus", () => {
    const u = (s: string) => new URL(s);
    // CI: Demo-VM über ihre IP im Wegwerf-Netz
    expect(zielPruefen(u("https://demo.schulos.test"), "192.168.251.2", false)).toEqual({ ok: true, tlsPruefen: false });
    expect(zielPruefen(u("http://localhost:3000"), "", false)).toEqual({ ok: true, tlsPruefen: false });
    expect(zielPruefen(u("https://127.0.0.1:8443"), "", false)).toMatchObject({ ok: true, tlsPruefen: false });
    // echte Schule: abgelehnt, auch wenn ZIEL_IP auf die VM zeigt bzw. der Name stimmt, die IP aber nicht
    const echt = zielPruefen(u("https://schule.example.de"), "", false);
    expect(echt).toMatchObject({ ok: false, tlsPruefen: true });
    expect(echt.grund).toContain("LASTTEST_ZIEL_OK=1");
    expect(zielPruefen(u("https://schule.example.de"), "192.168.251.2", false).ok).toBe(false);
    expect(zielPruefen(u("https://demo.schulos.test"), "10.0.0.5", false)).toMatchObject({ ok: false, tlsPruefen: true });
    expect(zielPruefen(u("https://demo.schulos.test.example.de"), "", false).ok).toBe(false);
    // ausdrücklich freigegeben: läuft, aber mit Zertifikatsprüfung
    expect(zielPruefen(u("https://schule.example.de"), "", true)).toEqual({ ok: true, tlsPruefen: true });
    expect(zielPruefen(u("https://schule.example.de"), "10.0.0.5", true)).toEqual({ ok: true, tlsPruefen: true });

    // zweite Sperre: die Instanz zeigt das Demo-Band
    expect(istDemoSeite('<div role="note" class="x">DEMO – keine echten Daten eingeben</div>')).toBe(true);
    expect(istDemoSeite("<div>VORSCHAU auf SchulOS 0.3.3 – Demo-Daten …</div>")).toBe(true);
    expect(istDemoSeite("<h1>Anmelden</h1><p>Gesamtschule Lindenhof</p>")).toBe(false);
  });

  it("Dauer wie bei k6", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(() => parseDuration("5 Minuten")).toThrow();
  });
});
