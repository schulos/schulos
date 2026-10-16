import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { DbHandle } from "@/core/db/client";
import { groupMembers, textDocs } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { applyClientUpdate, currentState, flushDocs, forgetDoc, fromBase64, LIMITS, openDoc, openDocIds, sweep, syncDoc, toBase64, withDoc } from "./live";
import { appendBlocks, docToText } from "./markdown";

const DOC = "text-7b-regeln";

/** Client-Dokument mit dem Stand des Servers */
async function clientFor(db: DbHandle["db"], id = DOC): Promise<Y.Doc> {
  const d = new Y.Doc();
  const state = await currentState(db, id);
  if (state) Y.applyUpdate(d, fromBase64(state)!);
  return d;
}

/** lokale Änderung → Update (Base64), wie der Browser es schickt */
function typing(doc: Y.Doc, text: string): string {
  const sv = Y.encodeStateVector(doc);
  appendBlocks(doc, [{ type: "paragraph", runs: [text] }]);
  return toBase64(Y.encodeStateAsUpdate(doc, sv));
}

describe("Texte – Live-Abgleich ohne WebSocket", () => {
  let h: DbHandle;
  let saveDelay: number;
  beforeAll(async () => {
    h = await createSeededTestDb();
    saveDelay = LIMITS.saveDelayMs;
    LIMITS.saveDelayMs = 50;
  }, 60_000);
  afterAll(async () => {
    LIMITS.saveDelayMs = saveDelay;
    for (const id of openDocIds()) forgetDoc(id);
    await h.close();
  });
  afterEach(() => vi.restoreAllMocks());

  it("Update anwenden: geht live nur an Anwesende, die Mitglied sind; wird verzögert gespeichert", async () => {
    const [other] = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(groupMembers.role, "member")));
    const got: Record<string, LiveEvent[]> = { lea: [], jana: [], other: [], daniel: [] };
    const offs = [
      subscribe("u-lea.schaefer", (e) => got.lea!.push(e)),
      subscribe("u-jana.brandt", (e) => got.jana!.push(e)),
      subscribe(other!.id, (e) => got.other!.push(e)),
      subscribe("u-daniel.okafor", (e) => got.daniel!.push(e)),
    ];
    // Jana und ein anderes Mitglied haben den Text offen (Sync), Daniel ist kein Mitglied – selbst mit „Sync“ (den die API ihm
    // nie erlaubt) bekäme er nichts; Lea ist Mitglied, hat den Text aber nicht offen
    await syncDoc(h.db, DOC, "u-jana.brandt", null);
    await syncDoc(h.db, DOC, other!.id, null);
    await syncDoc(h.db, DOC, "u-daniel.okafor", null);

    const lea = await clientFor(h.db);
    const r = await applyClientUpdate(h.db, DOC, "u-lea.schaefer", typing(lea, "Lea tippt"));
    expect(r).toEqual({ ok: true, editors: 4, crowded: false, changed: true });
    offs.forEach((f) => f());

    expect(got.lea).toHaveLength(1); // die Absenderin selbst (zweiter Tab) bekommt es auch
    expect(got.daniel).toEqual([]);
    expect(got.jana).toHaveLength(1);
    expect(got.other).toHaveLength(1);
    const ev = got.jana![0]!;
    expect(ev.type).toBe("text");
    if (ev.type !== "text") throw new Error();
    expect(ev.docId).toBe(DOC);
    // Janas Client wendet das Update an und hat denselben Text
    const jana = new Y.Doc();
    Y.applyUpdate(jana, fromBase64((await currentState(h.db, DOC))!)!);
    Y.applyUpdate(jana, fromBase64(ev.update!)!);
    expect(docToText(jana)).toContain("Lea tippt");
    expect(docToText(jana)).toBe(docToText(lea));

    // noch nicht gespeichert – nach dem Speichern steht es in der DB (höhere Version)
    const before = (await h.db.select({ version: textDocs.version }).from(textDocs).where(eq(textDocs.id, DOC)))[0]!.version;
    await flushDocs(h.db, DOC);
    const [row] = await h.db.select({ state: textDocs.state, version: textDocs.version }).from(textDocs).where(eq(textDocs.id, DOC));
    expect(row!.version).toBe(before + 1);
    const fromDb = new Y.Doc();
    Y.applyUpdate(fromDb, fromBase64(row!.state)!);
    expect(docToText(fromDb)).toContain("Lea tippt");
  });

  it("Speichern läuft von selbst nach saveDelayMs", async () => {
    const lea = await clientFor(h.db);
    await applyClientUpdate(h.db, DOC, "u-lea.schaefer", typing(lea, "automatisch"));
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await h.db.select({ state: textDocs.state }).from(textDocs).where(eq(textDocs.id, DOC));
    const fromDb = new Y.Doc();
    Y.applyUpdate(fromDb, fromBase64(row!.state)!);
    expect(docToText(fromDb)).toContain("automatisch");
  });

  it("Wiederverbindung: Sync liefert genau das Fehlende (Zustandsvektor), nicht blind alles; doppelt anwenden ist harmlos", async () => {
    const a = await clientFor(h.db);
    const b = await clientFor(h.db);
    // a tippt, b war offline (hat weder POST noch SSE mitbekommen)
    await applyClientUpdate(h.db, DOC, "u-lea.schaefer", typing(a, "nur bei a"));
    const svB = toBase64(Y.encodeStateVector(b));
    const s = await syncDoc(h.db, DOC, "u-jana.brandt", svB);
    if (!s || s === "invalid") throw new Error("sync");
    const full = fromBase64((await currentState(h.db, DOC))!)!;
    const diff = fromBase64(s.update)!;
    expect(diff.length).toBeLessThan(full.length / 2);
    Y.applyUpdate(b, diff);
    Y.applyUpdate(b, diff); // doppelt
    expect(docToText(b)).toBe(docToText(a));
    // b hat inzwischen selbst getippt, ohne dass es ankam → liefert anhand des Server-Zustandsvektors nach
    const svServer = fromBase64(s.sv)!;
    appendBlocks(b, [{ type: "paragraph", runs: ["offline bei b"] }]);
    const missing = Y.encodeStateAsUpdate(b, svServer);
    expect(missing.length).toBeGreaterThan(2);
    await applyClientUpdate(h.db, DOC, "u-jana.brandt", toBase64(missing));
    expect(await withDoc(h.db, DOC, docToText)).toContain("offline bei b");
    // leerer Zustandsvektor → voller Stand
    const s2 = await syncDoc(h.db, DOC, "u-jana.brandt", "");
    if (!s2 || s2 === "invalid") throw new Error("sync");
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, fromBase64(s2.update)!);
    expect(docToText(fresh)).toBe(await withDoc(h.db, DOC, docToText));
  });

  it("Grenzen: Müll, zu groß, zu viele, unbekannter Text, ungültiger Zustandsvektor", async () => {
    expect(await applyClientUpdate(h.db, DOC, "u-lea.schaefer", "nicht base64!")).toEqual({ ok: false, error: "invalid" });
    expect(await applyClientUpdate(h.db, DOC, "u-lea.schaefer", toBase64(new Uint8Array([7, 7, 7, 7])))).toEqual({ ok: false, error: "invalid" });
    expect(await applyClientUpdate(h.db, DOC, "u-lea.schaefer", 42)).toEqual({ ok: false, error: "invalid" });
    expect(await applyClientUpdate(h.db, DOC, "u-lea.schaefer", toBase64(new Uint8Array(LIMITS.updateBytes + 1)))).toEqual({ ok: false, error: "too-large" });
    expect(await applyClientUpdate(h.db, "gibts-nicht", "u-lea.schaefer", "AAAA")).toEqual({ ok: false, error: "missing" });
    expect(await syncDoc(h.db, "gibts-nicht", "u-lea.schaefer", null)).toBeNull();
    expect(await syncDoc(h.db, DOC, "u-lea.schaefer", "AAAA==")).toBe("invalid");
    expect(await syncDoc(h.db, DOC, "u-lea.schaefer", toBase64(new Uint8Array([255, 255, 255, 255, 255])))).toBe("invalid");

    // Rate-Limit je Person und Text
    const c = await clientFor(h.db);
    const max = LIMITS.updatesPerMinute;
    LIMITS.updatesPerMinute = 3;
    try {
      const results: boolean[] = [];
      for (let i = 0; i < 4; i++) results.push((await applyClientUpdate(h.db, DOC, "u-rate", typing(c, `r${i}`), 1_000_000 + i)).ok);
      expect(results).toEqual([true, true, true, false]);
      // neues Fenster → wieder erlaubt; andere Person war nie betroffen
      expect((await applyClientUpdate(h.db, DOC, "u-rate", typing(c, "später"), 1_000_000 + 61_000)).ok).toBe(true);
      expect((await applyClientUpdate(h.db, DOC, "u-lea.schaefer", typing(c, "lea"), Date.now() + 120_000)).ok).toBe(true);
    } finally {
      LIMITS.updatesPerMinute = max;
    }
  });

  it("~30 gleichzeitig: ab der Grenze einmal pro Fenster eine Warnung im Log, Hinweis in der Antwort", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = Date.now() + 2 * LIMITS.presenceMs; // alle bisher Anwesenden gelten dann als weg
    for (let i = 0; i < LIMITS.editors; i++) await syncDoc(h.db, DOC, `u-viele-${i}`, null, t0);
    const ok = await syncDoc(h.db, DOC, "u-jana.brandt", null, t0);
    if (!ok || ok === "invalid") throw new Error();
    expect(ok.crowded).toBe(true);
    expect(ok.editors).toBe(LIMITS.editors + 1);
    const again = await syncDoc(h.db, DOC, "u-lea.schaefer", null, t0 + 1000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/Personen bearbeiten gleichzeitig/);
    // nach presenceMs gelten sie als weg
    const later = await syncDoc(h.db, DOC, "u-lea.schaefer", null, t0 + LIMITS.presenceMs + 1);
    if (!later || later === "invalid" || !again || again === "invalid") throw new Error();
    expect(later.editors).toBe(1);
    expect(later.crowded).toBe(false);
  });

  it("zwei Prozesse: speichert ein anderer dazwischen, wird sein Stand zusammengeführt statt überschrieben", async () => {
    await flushDocs(h.db, DOC);
    const od = (await openDoc(h.db, DOC))!;
    const v0 = od.version;
    // „anderer Prozess“: schreibt direkt in die DB eine Version weiter mit einem Absatz, den wir nicht kennen
    const theirs = new Y.Doc();
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(od.doc));
    appendBlocks(theirs, [{ type: "paragraph", runs: ["vom anderen Prozess"] }]);
    await h.db
      .update(textDocs)
      .set({ state: toBase64(Y.encodeStateAsUpdate(theirs)), version: od.version + 1 })
      .where(eq(textDocs.id, DOC));
    // wir haben lokal auch etwas
    const mine = await clientFor(h.db);
    const got: LiveEvent[] = [];
    const off = subscribe("u-jana.brandt", (e) => got.push(e));
    await syncDoc(h.db, DOC, "u-jana.brandt", null);
    await applyClientUpdate(h.db, DOC, "u-jana.brandt", typing(mine, "von uns"));
    await flushDocs(h.db, DOC);
    off();
    const [row] = await h.db.select({ state: textDocs.state, version: textDocs.version }).from(textDocs).where(eq(textDocs.id, DOC));
    const merged = new Y.Doc();
    Y.applyUpdate(merged, fromBase64(row!.state)!);
    const text = docToText(merged);
    expect(text).toContain("vom anderen Prozess");
    expect(text).toContain("von uns");
    expect(row!.version).toBe(v0 + 2);
    expect(od.version).toBe(row!.version);
    // das Fremde ging live an die Anwesenden (eigenes Update + Nachlieferung des anderen Prozesses)
    expect(got.filter((e) => e.type === "text" && e.update)).toHaveLength(2);
  });

  it("P311-01: Sync bei Gleichstand – die Nachlieferung des Clients ist wirkungslos und ändert weder Version noch Löschfrist", async () => {
    await flushDocs(h.db, DOC);
    const before = (await h.db.select({ version: textDocs.version, updatedAt: textDocs.updatedAt }).from(textDocs).where(eq(textDocs.id, DOC)))[0]!;
    const client = await clientFor(h.db);
    const s = await syncDoc(h.db, DOC, "u-jana.brandt", toBase64(Y.encodeStateVector(client)));
    if (!s || s === "invalid") throw new Error("sync");
    Y.applyUpdate(client, fromBase64(s.update)!);
    // genau das, was der Browser nach dem Sync zurückschickt: Diff zum Server-Vektor – trägt das ganze DeleteSet, sonst nichts
    const echo = Y.encodeStateAsUpdate(client, fromBase64(s.sv)!);
    expect(echo.length).toBeGreaterThan(2);
    const got: LiveEvent[] = [];
    const off = subscribe("u-jana.brandt", (e) => got.push(e));
    const r = await applyClientUpdate(h.db, DOC, "u-jana.brandt", toBase64(echo));
    off();
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(got).toEqual([]);
    expect((await openDoc(h.db, DOC))!.pending).toBe(0);
    await flushDocs(h.db, DOC);
    const after = (await h.db.select({ version: textDocs.version, updatedAt: textDocs.updatedAt }).from(textDocs).where(eq(textDocs.id, DOC)))[0]!;
    expect(after).toEqual(before);
    // ein echtes Update zählt weiterhin – verteilt wird das Wirksame
    const off2 = subscribe("u-jana.brandt", (e) => got.push(e));
    expect(await applyClientUpdate(h.db, DOC, "u-jana.brandt", typing(client, "wirklich neu"))).toMatchObject({ ok: true, changed: true });
    off2();
    expect(got).toHaveLength(1);
  });

  it("P311-02: über der Dokumentgrenze nur noch Updates, die den Stand nicht vergrößern", async () => {
    // eigener Text, damit keine Lücken aus früheren (abgelehnten) Updates mitspielen
    const ID = "text-voll";
    await h.db.insert(textDocs).values({ id: ID, groupId: "g-7b", ownerId: "u-jana.brandt", title: "Voll" });
    let c = await clientFor(h.db, ID);
    expect(await applyClientUpdate(h.db, ID, "u-lea.schaefer", typing(c, "Anfang ".repeat(60)))).toMatchObject({ ok: true, changed: true });
    const od = (await openDoc(h.db, ID))!;
    const real = Y.encodeStateAsUpdate(od.doc).length;
    const max = LIMITS.docBytes;
    LIMITS.docBytes = real - 1; // der Text gilt ab jetzt als voll
    try {
      // kleine Einfügung: früher durchgewunken, jetzt abgelehnt (vorher ließ sich die Grenze mit 2-KB-Häppchen umgehen)
      expect(await applyClientUpdate(h.db, ID, "u-lea.schaefer", typing(c, "noch ein Satz"))).toEqual({ ok: false, error: "doc-full" });
      expect(await withDoc(h.db, ID, docToText)).not.toContain("noch ein Satz");
      // nach einer Ablehnung lädt der Browser den Serverstand neu (seine weiteren Updates bauten sonst auf dem Abgelehnten auf)
      c = await clientFor(h.db, ID);
      // Löschen (schrumpft den Stand) geht durch
      const frag = c.getXmlFragment("default");
      const sv = Y.encodeStateVector(c);
      c.transact(() => frag.delete(0, 1));
      expect(await applyClientUpdate(h.db, ID, "u-lea.schaefer", toBase64(Y.encodeStateAsUpdate(c, sv)))).toMatchObject({ ok: true, changed: true });
      expect(od.sizeBytes).toBeLessThan(real);
      expect(await withDoc(h.db, ID, docToText)).toBe("");
      // ein geschätzt zu großer Stand wird erst nachgemessen – liegt er tatsächlich unter der Grenze, läuft alles normal
      LIMITS.docBytes = max;
      od.sizeBytes = max + 1;
      expect(await applyClientUpdate(h.db, ID, "u-lea.schaefer", typing(c, "passt wieder"))).toMatchObject({ ok: true, changed: true });
      expect(od.sizeBytes).toBeLessThan(max);
    } finally {
      LIMITS.docBytes = max;
      forgetDoc(ID);
    }
  });

  it("wer die Gruppe verlässt, bekommt nach Ablauf des Mitglieder-Caches keine Updates mehr", async () => {
    const [other] = await h.db
      .select({ id: groupMembers.userId })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, "g-7b"), eq(groupMembers.role, "member")));
    const now = Date.now();
    await syncDoc(h.db, DOC, other!.id, null, now);
    await syncDoc(h.db, DOC, "u-jana.brandt", null, now);
    await h.db.delete(groupMembers).where(and(eq(groupMembers.groupId, "g-7b"), eq(groupMembers.userId, other!.id)));
    try {
      const c = await clientFor(h.db);
      // innerhalb des Caches (höchstens 30 s) kann noch etwas ankommen – danach nicht mehr
      await applyClientUpdate(h.db, DOC, "u-jana.brandt", typing(c, "eins"), now);
      const got: Record<string, number> = { other: 0, jana: 0 };
      const offs = [subscribe(other!.id, () => got.other!++), subscribe("u-jana.brandt", () => got.jana!++)];
      await applyClientUpdate(h.db, DOC, "u-jana.brandt", typing(c, "zwei"), now + LIMITS.membersCacheMs + 1);
      offs.forEach((f) => f());
      expect(got).toEqual({ other: 0, jana: 1 });
    } finally {
      await h.db.insert(groupMembers).values({ groupId: "g-7b", userId: other!.id, role: "member" }).onConflictDoNothing();
    }
  });

  it("Löschen während des Speicherns legt den Text nicht wieder an; Sweep räumt gespeicherte, unbenutzte Texte weg", async () => {
    const [d] = await h.db.insert(textDocs).values({ id: "text-tmp", groupId: "g-7b", ownerId: "u-jana.brandt", title: "Kurz" }).returning({ id: textDocs.id });
    const c = await clientFor(h.db, d!.id);
    await applyClientUpdate(h.db, d!.id, "u-jana.brandt", typing(c, "weg damit"));
    await h.db.delete(textDocs).where(eq(textDocs.id, d!.id));
    await flushDocs(h.db, d!.id); // Speichern findet die Zeile nicht mehr → Text wird vergessen, nicht neu angelegt
    expect(await h.db.select().from(textDocs).where(eq(textDocs.id, d!.id))).toEqual([]);
    expect(openDocIds()).not.toContain(d!.id);

    await flushDocs(h.db, DOC);
    expect(openDocIds()).toContain(DOC);
    await sweep(h.db, Date.now() + 2 * LIMITS.idleMs); // frühere Tests setzen lastAccess bis zu 30 s in die Zukunft
    expect(openDocIds()).not.toContain(DOC);
    // nächster Zugriff lädt den Text neu aus der DB – mit allem, was gespeichert war
    expect(await withDoc(h.db, DOC, docToText)).toContain("Lea tippt");
  });
});
