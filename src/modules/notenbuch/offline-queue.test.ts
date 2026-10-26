// Notenbuch (Review R3 N1/N2): Warteschlange im Browser – Schreibvorgänge nacheinander, Rücknahme nur der eigenen Eingabe,
// nie über eine unlesbare Warteschlange schreiben. Die IndexedDB ist hier ein Speicher-Objekt mit steuerbaren Verzögerungen und
// Fehlern (wie ein überlastetes Gerät).
import { describe, expect, it } from "vitest";
import { OfflineQueue, readQueueSafely } from "./offline-queue";
import { mergeOp, reconcileQueue, type OfflineOp } from "./offline-sync";

const op = (cell: string, value = "2", over: Partial<OfflineOp> = {}): OfflineOp => ({
  opId: `op-${cell}-${value}`,
  columnId: "c1",
  studentId: cell,
  value,
  comment: null,
  baseVersion: 0,
  at: "2026-10-26T10:00:00Z",
  ...over,
});

interface Deferred {
  ops: readonly OfflineOp[];
  resolve: () => void;
  reject: (e: Error) => void;
}

/** Ablage wie IndexedDB: jeder Schreibvorgang wartet, bis der Test ihn freigibt oder scheitern lässt. */
function fakeStore() {
  const stored: { ops: readonly OfflineOp[] | null } = { ops: null };
  const waiting: Deferred[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const write = (ops: readonly OfflineOp[]) =>
    new Promise<void>((resolve, reject) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      waiting.push({
        ops,
        resolve: () => {
          concurrent--;
          stored.ops = ops.length ? ops : null;
          resolve();
        },
        reject: (e) => {
          concurrent--;
          reject(e);
        },
      });
    });
  /** auf den nächsten Schreibvorgang warten (Mikrotasks laufen lassen) */
  const next = async (): Promise<Deferred> => {
    for (let i = 0; i < 50 && waiting.length === 0; i++) await Promise.resolve();
    const d = waiting.shift();
    if (!d) throw new Error("kein Schreibvorgang");
    return d;
  };
  return { stored, write, next, waiting, max: () => maxConcurrent };
}

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const ids = (ops: readonly OfflineOp[] | null) => (ops ?? []).map((o) => o.opId);

describe("Notenbuch Offline: Warteschlange im Browser (N1)", () => {
  it("parallele Eingaben: scheitert das Speichern von A, bleibt B – in Arbeitsspeicher und Ablage", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    const a = q.update((cur) => mergeOp(cur, op("s1")));
    const b = q.update((cur) => mergeOp(cur, op("s2")));
    (await s.next()).reject(new Error("QuotaExceeded"));
    const wB = await s.next();
    // B baut auf dem Stand **ohne** A auf – die gescheiterte Eingabe wird nicht mitgeschrieben
    expect(ids(wB.ops)).toEqual(["op-s2-2"]);
    wB.resolve();
    expect(await a).toEqual({ saved: false, applied: false });
    expect(await b).toEqual({ saved: true, applied: true });
    expect(ids(q.snapshot())).toEqual(["op-s2-2"]);
    expect(ids(s.stored.ops)).toEqual(["op-s2-2"]);
  });

  it("scheitert das Speichern von B nach gespeichertem A, bleibt A (kein Rücksprung auf eine alte Momentaufnahme)", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    const a = q.update((cur) => mergeOp(cur, op("s1")));
    const b = q.update((cur) => mergeOp(cur, op("s2")));
    (await s.next()).resolve();
    (await s.next()).reject(new Error("IndexedDB-Fehler"));
    expect((await a).applied).toBe(true);
    expect((await b).applied).toBe(false);
    expect(ids(q.snapshot())).toEqual(["op-s1-2"]);
    expect(ids(s.stored.ops)).toEqual(["op-s1-2"]);
  });

  it("Schreibvorgänge laufen nacheinander – nie zwei gleichzeitig, der letzte Stand gewinnt in der Ablage", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    const all = ["s1", "s2", "s3", "s4"].map((c) => q.update((cur) => mergeOp(cur, op(c))));
    expect(q.pendingWrites).toBe(4);
    for (let i = 0; i < 4; i++) {
      const w = await s.next();
      expect(s.waiting).toHaveLength(0);
      w.resolve();
    }
    await Promise.all(all);
    expect(s.max()).toBe(1);
    expect(q.pendingWrites).toBe(0);
    expect(ids(s.stored.ops)).toEqual(["op-s1-2", "op-s2-2", "op-s3-2", "op-s4-2"]);
  });

  it("Abgleich und Eingabe gleichzeitig: das Ergebnis des Abgleichs entfernt nur Gesendetes, die neue Eingabe bleibt", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    q.load([op("s1")]);
    const sent = q.snapshot();
    // während die Antwort gespeichert wird, trägt die Lehrkraft s2 ein
    const synced = q.update((cur) => reconcileQueue(cur, sent, [{ opId: "op-s1-2", status: "applied", version: 1 }]).queue, { keepOnFailure: true });
    const typed = q.update((cur) => mergeOp(cur, op("s2")));
    (await s.next()).resolve();
    (await s.next()).resolve();
    await Promise.all([synced, typed]);
    expect(ids(q.snapshot())).toEqual(["op-s2-2"]);
    expect(ids(s.stored.ops)).toEqual(["op-s2-2"]);
  });

  it("Eingabe während des Abgleichs, der Abgleich speichert danach: die Eingabe überlebt (Stand nach allen vorherigen Änderungen)", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    q.load([op("s1")]);
    const sent = q.snapshot();
    const typed = q.update((cur) => mergeOp(cur, op("s2")));
    const synced = q.update((cur) => reconcileQueue(cur, sent, [{ opId: "op-s1-2", status: "applied", version: 1 }]).queue, { keepOnFailure: true });
    (await s.next()).resolve();
    (await s.next()).resolve();
    await Promise.all([synced, typed]);
    expect(ids(s.stored.ops)).toEqual(["op-s2-2"]);
  });

  it("Abgleich-Ergebnis lässt sich nicht speichern: im Arbeitsspeicher trotzdem übernommen (Server hat angewendet)", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    q.load([op("s1")]);
    const r = q.update(() => [], { keepOnFailure: true });
    (await s.next()).reject(new Error("IndexedDB-Fehler"));
    expect(await r).toEqual({ saved: false, applied: true });
    expect(q.snapshot()).toEqual([]);
  });

  it("Ausschalten während eines Schreibvorgangs: der alte Schreibvorgang füllt den geleerten Stand nicht wieder auf", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    const a = q.update((cur) => mergeOp(cur, op("s1")));
    const w = await s.next();
    q.reset();
    w.resolve();
    expect((await a).applied).toBe(false);
    expect(q.snapshot()).toEqual([]);
    await q.idle();
  });

  it("meldet jeden neuen Stand für die Anzeige „ausstehend“ – erst nach dem Speichern", async () => {
    const s = fakeStore();
    const seen: string[][] = [];
    const q = new OfflineQueue(s.write, (ops) => seen.push(ids(ops)));
    const a = q.update((cur) => mergeOp(cur, op("s1")));
    const w = await s.next();
    expect(seen).toEqual([]);
    w.resolve();
    await a;
    expect(seen).toEqual([["op-s1-2"]]);
  });
});

describe("Notenbuch Offline: unlesbare Warteschlange (N2)", () => {
  it("nach einem Lesefehler: keine Eingabe, kein Schreiben – die gespeicherte Warteschlange bleibt unberührt", async () => {
    const s = fakeStore();
    s.stored.ops = [op("alt-1"), op("alt-2")];
    const q = new OfflineQueue(s.write);
    q.markUnreadable();
    expect(q.unreadable).toBe(true);
    const r = await q.update((cur) => mergeOp(cur, op("neu")));
    expect(r).toEqual({ saved: false, applied: false });
    await flush();
    expect(s.waiting).toHaveLength(0);
    expect(ids(s.stored.ops)).toEqual(["op-alt-1-2", "op-alt-2-2"]);
    expect(q.snapshot()).toEqual([]);
  });

  it("Eingaben, die vor dem Sperren eingereiht waren, schreiben nach dem Sperren nicht mehr", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    const a = q.update((cur) => mergeOp(cur, op("s1")));
    const b = q.update((cur) => mergeOp(cur, op("s2")));
    const wA = await s.next();
    q.markUnreadable();
    wA.resolve();
    expect((await a).applied).toBe(false);
    expect(await b).toEqual({ saved: false, applied: false });
    await flush();
    expect(s.waiting).toHaveLength(0);
  });

  it("erneut erfolgreich gelesen (load) → wieder freigegeben", async () => {
    const s = fakeStore();
    const q = new OfflineQueue(s.write);
    q.markUnreadable();
    q.load([op("alt")]);
    expect(q.unreadable).toBe(false);
    const r = q.update((cur) => mergeOp(cur, op("neu")));
    const w = await s.next();
    expect(ids(w.ops)).toEqual(["op-alt-2", "op-neu-2"]);
    w.resolve();
    expect((await r).applied).toBe(true);
  });

  it("readQueueSafely: kurzer Fehler → zweiter Versuch; zweimal Fehler → „unbekannt“, nicht leer", async () => {
    let calls = 0;
    const flaky = async () => {
      if (calls++ === 0) throw new Error("IndexedDB-Fehler");
      return [op("s1")];
    };
    expect(await readQueueSafely(flaky)).toEqual({ ok: true, ops: [op("s1")] });
    expect(calls).toBe(2);
    const broken = async (): Promise<OfflineOp[]> => {
      throw new Error("Entschlüsseln fehlgeschlagen");
    };
    expect(await readQueueSafely(broken)).toEqual({ ok: false });
    expect(await readQueueSafely(async () => [])).toEqual({ ok: true, ops: [] });
  });
});
