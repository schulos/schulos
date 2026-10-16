// Notenbuch (P5-20): reine Abgleichlogik – Revision je Zelle, Idempotenz, Konflikt, Warteschlange, Auflösung, Frist.
import { describe, expect, it } from "vitest";
import {
  applySyncResults,
  classifyOp,
  mergeOp,
  OFFLINE_MAX_DAYS,
  offlineExpired,
  reconcileQueue,
  resolveConflict,
  resolveInQueue,
  transferAllQueues,
  type OfflineOp,
  type QueueStore,
  type SyncResult,
} from "./offline-sync";

const op = (over: Partial<OfflineOp> = {}): OfflineOp => ({
  opId: "op-1",
  columnId: "c1",
  studentId: "s1",
  value: "2",
  comment: null,
  baseVersion: 0,
  at: "2026-10-13T10:00:00Z",
  ...over,
});

describe("Notenbuch Offline: Abgleich (rein)", () => {
  it("classifyOp: gleiche Revision → anwenden; leere Zelle = Revision 0", () => {
    expect(classifyOp(null, op())).toBe("apply");
    expect(classifyOp({ value: "3", comment: null, version: 2 }, op({ baseVersion: 2 }))).toBe("apply");
  });

  it("classifyOp: Server trägt schon genau diesen Wert → schon angewendet (Wiederholung ist gefahrlos)", () => {
    expect(classifyOp({ value: "2", comment: null, version: 1 }, op({ baseVersion: 0 }))).toBe("applied");
    expect(classifyOp({ value: "2", comment: "gut", version: 5 }, op({ baseVersion: 1, comment: "gut" }))).toBe("applied");
    // Löschen, das schon passiert ist
    expect(classifyOp(null, op({ value: "", baseVersion: 3 }))).toBe("applied");
  });

  it("classifyOp: andere Revision und anderer Inhalt → Konflikt (auch nur im Kommentar)", () => {
    expect(classifyOp({ value: "3", comment: null, version: 1 }, op({ baseVersion: 0 }))).toBe("conflict");
    expect(classifyOp({ value: "2", comment: "anders", version: 1 }, op({ baseVersion: 0 }))).toBe("conflict");
    expect(classifyOp({ value: "2", comment: null, version: 2 }, op({ value: "", baseVersion: 1 }))).toBe("conflict");
  });

  it("mergeOp: je Zelle eine Änderung, die spätere ersetzt Wert und Kommentar, die Grundrevision bleibt", () => {
    const q1 = mergeOp([], op({ opId: "a", baseVersion: 4 }));
    const q2 = mergeOp(q1, op({ opId: "b", value: "5", baseVersion: 0 }));
    expect(q2).toHaveLength(1);
    expect(q2[0]).toMatchObject({ opId: "b", value: "5", baseVersion: 4 });
    const q3 = mergeOp(q2, op({ opId: "c", studentId: "s2" }));
    expect(q3.map((o) => o.opId)).toEqual(["b", "c"]);
  });

  it("applySyncResults: angewendet raus, Ablehnung zur Anzeige, Konflikt zur Anzeige und bleibt (GATE-5a), ohne Antwort bleibt in der Warteschlange", () => {
    const queue = [op({ opId: "a" }), op({ opId: "b", studentId: "s2" }), op({ opId: "c", studentId: "s3" }), op({ opId: "d", studentId: "s4" })];
    const results: SyncResult[] = [
      { opId: "a", status: "applied", version: 1 },
      { opId: "b", status: "conflict", server: { value: "4", comment: null, version: 2 }, serverLabel: "Tobias Kleine" },
      { opId: "c", status: "rejected", reason: "gesperrt" },
    ];
    const out = applySyncResults(queue, results);
    expect([...out.applied.keys()]).toEqual(["c1:s1"]);
    expect(out.applied.get("c1:s1")!.version).toBe(1);
    expect(out.conflicts.map((c) => c.op.opId)).toEqual(["b"]);
    expect(out.conflicts[0]!.serverLabel).toBe("Tobias Kleine");
    expect(out.rejected.map((r) => r.op.opId)).toEqual(["c"]);
    expect(out.queue.map((o) => o.opId)).toEqual(["b", "d"]);
  });

  it("G5A-C03: während des Abgleichs eingetragene bzw. ersetzte Änderungen bleiben erhalten (auf die eigene Übertragung aufgesetzt)", () => {
    const sent = [op({ opId: "a", baseVersion: 0 }), op({ opId: "b", studentId: "s2", baseVersion: 7 })];
    // während der Übertragung: neue Zelle s3, und s1 erneut geändert (mergeOp ersetzt a durch a2, Grundrevision bleibt 0)
    let current = mergeOp(sent, op({ opId: "n", studentId: "s3" }));
    current = mergeOp(current, op({ opId: "a2", value: "4" }));
    const results: SyncResult[] = [
      { opId: "a", status: "applied", version: 41 },
      { opId: "b", status: "applied", version: 42 },
    ];
    const out = reconcileQueue(current, sent, results);
    expect(out.queue.map((o) => o.opId).sort()).toEqual(["a2", "n"]);
    // a2 baut auf der eigenen, gerade übertragenen Revision auf – kein Konflikt mit sich selbst
    expect(out.queue.find((o) => o.opId === "a2")).toMatchObject({ value: "4", baseVersion: 41 });
    // nur b meldet „angewendet“ (a ist durch a2 ersetzt – die Zelle springt nicht auf den älteren Wert zurück)
    expect([...out.applied.keys()]).toEqual(["c1:s2"]);
  });

  it("resolveInQueue: Server-Wert nimmt die Änderung heraus, meine Eingabe setzt neu auf; neuere Eingabe derselben Zelle gilt", () => {
    const conflict = { op: op({ opId: "a", baseVersion: 0 }), server: { value: "4", comment: null, version: 9 }, serverLabel: null };
    const q = [conflict.op, op({ opId: "x", studentId: "s2" })];
    expect(resolveInQueue(q, conflict, "server", "n", "t").map((o) => o.opId)).toEqual(["x"]);
    expect(resolveInQueue(q, conflict, "mine", "n", "t").find((o) => o.studentId === "s1")).toMatchObject({ opId: "n", baseVersion: 9, value: "2" });
    const newer = [op({ opId: "a3", value: "1", baseVersion: 0 })];
    expect(resolveInQueue(newer, conflict, "mine", "n", "t")).toEqual([expect.objectContaining({ opId: "a3", value: "1", baseVersion: 9 })]);
    expect(resolveInQueue(newer, conflict, "server", "n", "t")).toEqual(newer);
  });

  it("G5A-C04: letzter Abruf überträgt die Warteschlangen aller Bücher; Konflikte und nicht erreichbare Bücher bleiben offen", async () => {
    const store = new Map<string, OfflineOp[]>([
      ["buch-a", [op({ opId: "a" })]],
      ["buch-b", [op({ opId: "b" }), op({ opId: "b2", studentId: "s2" })]],
      ["buch-c", [op({ opId: "c" })]],
    ]);
    const qs: QueueStore = {
      books: async () => [...store.keys()],
      read: async (b) => store.get(b) ?? [],
      write: async (b, ops) => {
        if (ops.length) store.set(b, [...ops]);
        else store.delete(b);
      },
    };
    const synced: string[] = [];
    const r = await transferAllQueues(qs, async (bookId, ops) => {
      synced.push(bookId);
      if (bookId === "buch-c") throw new Error("offline");
      return ops.map((o): SyncResult =>
        o.opId === "b2" ? { opId: o.opId, status: "conflict", server: { value: "5", comment: null, version: 3 }, serverLabel: null } : { opId: o.opId, status: "applied", version: 2 },
      );
    });
    expect(synced).toEqual(["buch-a", "buch-b", "buch-c"]);
    expect(r).toEqual({ remaining: 2, books: 2 });
    expect([...store.keys()]).toEqual(["buch-b", "buch-c"]);
    expect(store.get("buch-b")!.map((o) => o.opId)).toEqual(["b2"]);
  });

  it("resolveConflict: „meine Eingabe“ setzt neu auf die Server-Revision auf, „Server-Wert“ verwirft", () => {
    const conflict = { op: op({ opId: "a", baseVersion: 0 }), server: { value: "4", comment: null, version: 3 }, serverLabel: null };
    const mine = resolveConflict(conflict, "mine", "op-neu", "2026-10-13T11:00:00Z");
    expect(mine).toMatchObject({ opId: "op-neu", value: "2", baseVersion: 3, at: "2026-10-13T11:00:00Z" });
    expect(resolveConflict(conflict, "server", "op-neu", "x")).toBeNull();
    // Server-Zelle inzwischen gelöscht → Revision 0
    expect(resolveConflict({ ...conflict, server: null }, "mine", "n", "x")!.baseVersion).toBe(0);
  });

  it("Frist: 7 Tage, Ablauf einschließlich", () => {
    expect(OFFLINE_MAX_DAYS).toBe(7);
    const t = new Date("2026-10-20T00:00:00Z");
    expect(offlineExpired(t, new Date(t.getTime() - 1))).toBe(false);
    expect(offlineExpired(t, t)).toBe(true);
  });
});
