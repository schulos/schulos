import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROPPED_MESSAGE, Outbox, OUTBOX, pendingElements, restoreSafely, revertElements, RevertQueue, stripDisallowed, takeBatch, type OutboxEvent, type SyncEl, type Ver } from "./outbox";

// P312-01/02/04/05: Sendelogik des Browsers ohne Excalidraw – Szene als Array, Server als Attrappe.

type E = SyncEl & { text?: string };
const el = (id: string, version: number, extra: Partial<E> = {}): E => ({ id, type: "rectangle", version, versionNonce: 1, isDeleted: false, ...extra });

interface Call {
  body: { elements: E[] };
  keepalive: boolean;
  resolve: (status: number, json?: unknown) => void;
}

function setup(scene: E[]) {
  const calls: Call[] = [];
  const events: OutboxEvent[] = [];
  const box = new Outbox({
    elements: () => scene,
    send: (body, keepalive) =>
      new Promise((resolve) => {
        calls.push({ body: JSON.parse(body) as { elements: E[] }, keepalive, resolve: (status, json = {}) => resolve({ status, json: async () => json }) });
      }),
    emit: (e) => events.push(e),
  });
  return { box, calls, events, ids: (c: Call) => c.body.elements.map((e) => e.id) };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

describe("Tafeln – Sendelogik (Outbox)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reine Hilfen: was raus muss, Unerlaubtes, Zurücknehmen", () => {
    const known = new Map<string, Ver>([
      ["a", { version: 2, versionNonce: 1 }],
      ["b", { version: 2, versionNonce: 1 }],
    ]);
    const scene = [el("a", 2), el("b", 3), el("c", 1), el("d", 1, { isDeleted: true }), el("e", 1, { type: "embeddable" }), el("f", 1, { fileId: "x" })];
    expect(pendingElements(scene, known).map((e) => e.id)).toEqual(["b", "c"]);
    // abgelehnte Fassung nicht wiederholen, neuere schon
    expect(pendingElements(scene, known, new Map([["b", { version: 3, versionNonce: 1 }]])).map((e) => e.id)).toEqual(["c"]);
    expect(pendingElements([el("b", 4)], known, new Map([["b", { version: 3, versionNonce: 1 }]])).map((e) => e.id)).toEqual(["b"]);

    expect(stripDisallowed([el("a", 1), el("b", 1, { type: "text" })])).toBeNull();
    expect(stripDisallowed(scene)!.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);

    const reverted = revertElements([el("a", 5, { text: "lokal" }), el("n", 1), el("x", 1)], [el("a", 2, { text: "server" }), el("x", 9)], new Set(["a", "n"]));
    expect(reverted).toEqual([el("a", 2, { text: "server" }), el("x", 1)]);
  });

  it("Bündel nach Anzahl und Bytes (P312-04); ein einzelnes zu großes Element geht allein", () => {
    const big = (id: string) => el(id, 1, { text: "ä".repeat(1000) }); // ~2 KB je Element (UTF-8)
    const all = Array.from({ length: 10 }, (_, i) => big(`e${i}`));
    const r = takeBatch(all, 100, 5000);
    expect(r.batch.length).toBe(2);
    expect(r.more).toBe(true);
    expect(new TextEncoder().encode(r.body).length).toBeLessThanOrEqual(5000);
    expect(JSON.parse(r.body)).toEqual({ elements: r.batch });
    expect(takeBatch(all, 3, 1e9)).toMatchObject({ more: true, batch: all.slice(0, 3) });
    expect(takeBatch(all, 100, 10)).toMatchObject({ more: true, batch: all.slice(0, 1) });
    expect(takeBatch([], 100, 10)).toEqual({ batch: [], body: '{"elements":[]}', more: false });
  });

  it("großer Rückstand geht in mehreren POSTs ≤ maxBytes raus, keiner wird abgewiesen", async () => {
    const scene = Array.from({ length: 300 }, (_, i) => el(`s${i}`, 1, { text: "x".repeat(3000) })); // ≈ 900 KB
    const { box, calls } = setup(scene);
    void box.flush();
    for (let i = 0; i < 5 && calls.length > i; i++) {
      const c = calls[i]!;
      expect(JSON.stringify(c.body).length).toBeLessThanOrEqual(OUTBOX.maxBytes);
      c.resolve(200, { editors: 1 });
      await tick();
    }
    expect(calls.length).toBe(3);
    expect(calls.flatMap((c) => c.body.elements).length).toBe(300);
    expect(box.pending()).toEqual([]);
  });

  it("Änderung während eines laufenden POST geht danach raus (P312-02), Status erst dann „synced“", async () => {
    const scene = [el("a", 1)];
    const { box, calls, events, ids } = setup(scene);
    box.schedule();
    await vi.advanceTimersByTimeAsync(OUTBOX.flushMs);
    expect(calls).toHaveLength(1);
    // währenddessen: neuer Pfeil, Timer feuert, flush endet sofort (inflight)
    scene.push(el("pfeil", 1, { type: "arrow" }));
    box.schedule();
    await vi.advanceTimersByTimeAsync(OUTBOX.flushMs);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(200, { editors: 2, crowded: false });
    await tick();
    expect(events.some((e) => e.kind === "synced")).toBe(false);
    expect(calls).toHaveLength(2);
    expect(ids(calls[1]!)).toEqual(["pfeil"]);
    calls[1]!.resolve(200, { editors: 2 });
    await tick();
    expect(events.at(-1)).toEqual({ kind: "synced" });
    expect(events).toContainEqual({ kind: "reply", editors: 2, crowded: false, dropped: 0 });
  });

  it("endgültige Ablehnung (400/413): Grund melden, diese Fassung nicht wiederholen, weiter senden (P312-01/04)", async () => {
    const scene = [el("voll", 1)];
    const { box, calls, events, ids } = setup(scene);
    void box.flush();
    calls[0]!.resolve(413, { error: "Die Tafel ist voll" });
    await tick();
    expect(events).toContainEqual({ kind: "rejected", error: "Die Tafel ist voll", ids: ["voll"] });
    expect(calls).toHaveLength(1); // nicht in Schleife
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    // die Tafel verstummt nicht: neue Änderungen gehen raus
    scene.push(el("neu", 1));
    box.schedule();
    await vi.advanceTimersByTimeAsync(OUTBOX.flushMs);
    expect(ids(calls[1]!)).toEqual(["neu"]);
    calls[1]!.resolve(200);
    await tick();
    // nach dem Zurücknehmen (board.tsx übernimmt den Serverstand) zählt das Element wieder – auch eine Fassung, die die
    // abgelehnte nicht übertrifft (Excalidraw zählt vom Serverstand aus weiter)
    expect(box.pending()).toEqual([]);
    box.forgetRejected(["voll"]);
    box.schedule(0);
    await tick();
    expect(ids(calls[2]!)).toEqual(["voll"]);
  });

  it("Fehler/Netz weg: offline, mit wachsendem Abstand erneut; 403 → nur lesen, 404 → gelöscht, danach nichts mehr", async () => {
    const scene = [el("a", 1)];
    const { box, calls, events } = setup(scene);
    void box.flush();
    calls[0]!.resolve(503);
    await tick();
    expect(events).toContainEqual({ kind: "offline" });
    await vi.advanceTimersByTimeAsync(OUTBOX.flushMs * 2);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve(403);
    await tick();
    expect(events.at(-1)).toEqual({ kind: "readonly" });
    box.schedule(0);
    box.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2); // auch beim Abbauen nichts mehr

    const other = setup([el("b", 1)]);
    void other.box.flush();
    other.calls[0]!.resolve(404);
    await tick();
    expect(other.events.at(-1)).toEqual({ kind: "removed" });
  });

  it("Abbauen (SPA-Navigation) schickt den Rest per keepalive, dann ist Ruhe (P312-05)", async () => {
    const scene = [el("a", 1)];
    const { box, calls } = setup(scene);
    box.schedule(); // Timer läuft noch (250 ms), da wird die Seite verlassen
    box.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keepalive).toBe(true);
    expect(calls[0]!.body.elements.map((e) => e.id)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    box.close(); // zweimal: nichts doppelt
    expect(calls).toHaveLength(1);

    // keepalive-Bündel bleibt unter der Browsergrenze
    const many = setup(Array.from({ length: 100 }, (_, i) => el(`k${i}`, 1, { text: "x".repeat(2000) })));
    many.box.sendRest();
    expect(JSON.stringify(many.calls[0]!.body).length).toBeLessThanOrEqual(OUTBOX.keepaliveBytes);
  });

  it("Web-Einbettungen und Bilder gehen nie raus", async () => {
    const { box, calls, ids } = setup([el("e", 1, { type: "embeddable" }), el("i", 1, { type: "image", fileId: "f" }), el("ok", 1)]);
    void box.flush();
    expect(ids(calls[0]!)).toEqual(["ok"]);
  });
  it("G3B-02: vom Server einzeln verworfene Fassungen gelten nicht als angekommen, sondern werden zurückgenommen", async () => {
    const scene = [el("ok", 1), el("hoch", 20_000), el("weg", 3, { isDeleted: true })];
    const { box, calls, events } = setup(scene);
    box.known.set("weg", { version: 2, versionNonce: 1 });
    void box.flush();
    calls[0]!.resolve(200, { editors: 1, changed: 1, dropped: 2, droppedIds: ["hoch", "weg", "fremd", 5] });
    await tick();
    expect(box.known.get("ok")).toEqual({ version: 1, versionNonce: 1 });
    expect(box.known.has("hoch")).toBe(false);
    expect(box.known.get("weg")).toEqual({ version: 2, versionNonce: 1 }); // bleibt beim Serverstand
    expect(events).toContainEqual({ kind: "rejected", error: DROPPED_MESSAGE, ids: ["hoch", "weg"] });
    // nur, was nicht zugeordnet werden kann, zählt noch als „verworfen“ in der Antwort
    expect(events).toContainEqual({ kind: "reply", editors: 1, crowded: false, dropped: 0 });
    // nicht in Schleife erneut senden
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(box.pending()).toEqual([]);
  });
});

describe("Tafeln – kaputte Elemente und Rücknahmen im Browser (G3B-01/04)", () => {
  it("restoreSafely: ein Element, das restoreElements zum Absturz bringt, wird einzeln verworfen", () => {
    // Attrappe wie Excalidraw: wirft für das ganze Array, sobald ein Element boundElementIds kein Array hat
    const restore = (xs: { id: string; boundElementIds?: unknown }[]) =>
      xs.map((x) => {
        if (x.boundElementIds !== undefined) (x.boundElementIds as string[]).map((b) => b);
        return { id: x.id, restored: true };
      });
    const all = [{ id: "a" }, { id: "kaputt", boundElementIds: 1 }, { id: "b" }];
    const r = restoreSafely(all, restore);
    expect(r.elements).toEqual([{ id: "a", restored: true }, { id: "b", restored: true }]);
    expect(r.dropped).toEqual([{ id: "kaputt", boundElementIds: 1 }]);
    expect(restoreSafely([{ id: "a" }], restore)).toEqual({ elements: [{ id: "a", restored: true }], dropped: [] });
    // scheitert selbst der Rest (gemeinsamer Fehler), bleibt die Tafel leer statt abzustürzen
    let n = 0;
    const flaky = (xs: { id: string }[]) => {
      if (xs.length > 1 || ++n > 2) throw new Error("x");
      return xs;
    };
    expect(restoreSafely([{ id: "a" }, { id: "b" }], flaky)).toEqual({ elements: [], dropped: [{ id: "a" }, { id: "b" }] });
  });

  it("RevertQueue: Rücknahmen bleiben vorgemerkt, bis ein Sync gelingt; währenddessen Hinzugekommenes bleibt", () => {
    const q = new RevertQueue();
    expect(q.take()).toBeUndefined();
    q.add(["a", "b"]);
    const first = q.take();
    expect([...first!]).toEqual(["a", "b"]);
    // Sync scheitert (429/Netz): done wird nicht aufgerufen, der nächste Sync nimmt sie wieder mit
    const second = q.take();
    expect([...second!]).toEqual(["a", "b"]);
    q.add(["c"]); // neue Ablehnung, während der zweite Sync läuft
    q.done(second);
    expect([...q.take()!]).toEqual(["c"]);
    q.done(q.take());
    expect(q.size).toBe(0);
    q.done(undefined);
  });
});
