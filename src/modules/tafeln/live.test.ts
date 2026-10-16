import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { fileNodes, groupFeatures, groupMembers, groups } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { localStorage, newStorageKey, type FileStorage } from "@/core/files/storage";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { deleteNode, GROUP_FOLDER_FEATURE, QUOTA, renameNode, usage } from "@/modules/dateien/service";
import { ValidationError } from "@/modules/verwaltung/users";
import { applyBoardUpdate, flushBoards, forgetBoard, LIMITS, openBoardIds, readStored, sweep, syncBoard } from "./live";
import { parseScene, serializeScene, type BoardElement } from "./scene";
import { boardAccess, boardGroups, createBoard, listBoards } from "./service";

const el = (id: string, version: number, extra: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  isDeleted: false,
  index: "a0",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

describe("Tafeln – Rechte, Live-Abgleich, Speichern", () => {
  let h: DbHandle;
  let dir: string;
  let storage: FileStorage;
  let saveDelay: number;
  let board: string;
  const p = (id: string) => loadPermissions(h.db, id);

  /** gespeicherte Szene lesen */
  const stored = async (id: string) => {
    const [row] = await h.db.select({ key: fileNodes.storageKey, size: fileNodes.size }).from(fileNodes).where(eq(fileNodes.id, id));
    const text = await readStored(storage, row!.key!, 10 * 1024 * 1024);
    return { scene: parseScene(text as string)!, size: row!.size, key: row!.key! };
  };

  beforeAll(async () => {
    h = await createSeededTestDb();
    dir = await mkdtemp(path.join(os.tmpdir(), "schulos-tafeln-"));
    storage = localStorage(dir);
    saveDelay = LIMITS.saveDelayMs;
    LIMITS.saveDelayMs = 30;
    board = await createBoard(h.db, storage, await p("u-jana.brandt"), { title: "Brüche", groupId: "g-7b" });
  }, 60_000);
  afterAll(async () => {
    LIMITS.saveDelayMs = saveDelay;
    for (const id of openBoardIds()) forgetBoard(id);
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it("Tafel anlegen: Datei „*.excalidraw“ im Gruppenordner; Mitglieder ja, Fremde nein", async () => {
    const [node] = await h.db.select().from(fileNodes).where(eq(fileNodes.id, board));
    expect(node).toMatchObject({ kind: "file", name: "Brüche.excalidraw", groupId: "g-7b", parentId: null, mime: "application/vnd.excalidraw+json", createdBy: "u-jana.brandt" });
    expect((await stored(board)).scene.elements).toEqual([]);

    expect(await boardAccess(h.db, await p("u-lea.schaefer"), board)).toMatchObject({ title: "Brüche", groupName: "Klasse 7b", canWrite: true });
    expect(await boardAccess(h.db, await p("u-daniel.okafor"), board)).toBeNull();
    expect((await listBoards(h.db, await p("u-lea.schaefer"))).map((b) => b.id)).toContain(board);
    expect((await listBoards(h.db, await p("u-daniel.okafor"))).map((b) => b.id)).not.toContain(board);
    // Schülerin darf in ihrer Klasse auch anlegen (wie Dateien hochladen), nicht in fremden Gruppen
    const lea = await p("u-lea.schaefer");
    expect((await boardGroups(h.db, lea)).map((g) => g.id)).toContain("g-7b");
    await expect(createBoard(h.db, storage, lea, { title: "X", groupId: "g-8a" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createBoard(h.db, storage, lea, { title: "  .excalidraw ", groupId: "g-7b" })).rejects.toBeInstanceOf(ValidationError);
    // gleicher Name → „(2)“
    const second = await createBoard(h.db, storage, lea, { title: "Brüche.excalidraw", groupId: "g-7b" });
    const [n2] = await h.db.select({ name: fileNodes.name }).from(fileNodes).where(eq(fileNodes.id, second));
    expect(n2!.name).toBe("Brüche (2).excalidraw");

    // andere Dateien sind keine Tafeln
    const key = newStorageKey();
    await storage.put(key, new TextEncoder().encode("{}"));
    const [pdf] = await h.db.insert(fileNodes).values({ kind: "file", name: "Brüche.pdf", groupId: "g-7b", storageKey: key, size: 2 }).returning({ id: fileNodes.id });
    expect(await boardAccess(h.db, await p("u-jana.brandt"), pdf!.id)).toBeNull();
  });

  it("Gruppenordner aus → kein Zugriff; archivierte Gruppe → nur ansehen", async () => {
    await h.db.delete(groupFeatures).where(and(eq(groupFeatures.groupId, "g-7b"), eq(groupFeatures.feature, GROUP_FOLDER_FEATURE)));
    try {
      expect(await boardAccess(h.db, await p("u-jana.brandt"), board)).toBeNull();
      expect(await listBoards(h.db, await p("u-lea.schaefer"))).toEqual([]);
    } finally {
      await h.db.insert(groupFeatures).values({ groupId: "g-7b", feature: GROUP_FOLDER_FEATURE });
    }
    await h.db.update(groups).set({ archivedAt: new Date() }).where(eq(groups.id, "g-7b"));
    try {
      expect(await boardAccess(h.db, await p("u-lea.schaefer"), board)).toMatchObject({ archived: true, canWrite: false });
      expect((await boardGroups(h.db, await p("u-lea.schaefer"))).map((g) => g.id)).not.toContain("g-7b");
    } finally {
      await h.db.update(groups).set({ archivedAt: null }).where(eq(groups.id, "g-7b"));
    }
  });

  it("Update: höhere Version gewinnt, nur Übernommenes geht live an Anwesende, die Mitglied sind; gespeichert wird verzögert", async () => {
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
    try {
      await syncBoard(h.db, storage, board, "u-jana.brandt");
      await syncBoard(h.db, storage, board, "u-daniel.okafor"); // die API ließe ihn nie – selbst dann bekommt er nichts
      const r = await applyBoardUpdate(h.db, storage, board, "u-lea.schaefer", [el("r1", 1), el("r2", 1, { index: "a1" })]);
      expect(r).toEqual({ ok: true, changed: 2, dropped: 0, droppedIds: [], editors: 3, crowded: false });
      expect(got.jana).toHaveLength(1);
      expect(got.lea).toHaveLength(1); // die Absenderin (zweiter Tab) auch
      expect(got.other).toEqual([]); // Mitglied, aber nicht anwesend
      expect(got.daniel).toEqual([]);
      const ev = got.jana![0]!;
      if (ev.type !== "tafel") throw new Error(ev.type);
      expect(ev.boardId).toBe(board);
      expect(ev.elements.map((e) => e.id)).toEqual(["r1", "r2"]);

      // ältere bzw. gleiche Fassung: nichts übernommen, nichts verteilt
      got.jana = [];
      expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("r1", 1), el("r2", 1, { index: "a1" })])).toMatchObject({ ok: true, changed: 0 });
      expect(got.jana).toEqual([]);
      // gemischt: nur r1 (neuer) geht raus; dieselbe id doppelt → stärkste Fassung
      const mixed = await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("r1", 3, { width: 30 }), el("r1", 2, { width: 20 }), el("r2", 1, { index: "a1" })]);
      expect(mixed).toMatchObject({ changed: 1 });
      const ev2 = got.jana![0]!;
      if (ev2.type !== "tafel") throw new Error(ev2.type);
      expect(ev2.elements).toEqual([expect.objectContaining({ id: "r1", version: 3, width: 30 })]);
    } finally {
      offs.forEach((f) => f());
    }
    await flushBoards(h.db, storage, board);
    const s = await stored(board);
    expect(s.scene.elements.map((e) => [e.id, e.version])).toEqual([
      ["r1", 3],
      ["r2", 1],
    ]);
    expect(s.size).toBe(Buffer.byteLength(serializeScene(s.scene.elements)));
    // alte Fassungen sind aus dem Speicher weg (nur die aktuelle Datei bleibt)
    const keys = (await storage.list()).map((f) => f.key);
    expect(keys).toContain(s.key);
  });

  it("Sync liefert den vollen Stand inkl. Grabsteine; Wiederverbindung holt Verpasstes", async () => {
    await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("r2", 2, { index: "a1", isDeleted: true })]);
    const s = await syncBoard(h.db, storage, board, "u-lea.schaefer");
    if (typeof s === "string") throw new Error(s);
    expect(s.elements.map((e) => [e.id, e.isDeleted])).toEqual([
      ["r1", false],
      ["r2", true],
    ]);
    expect(s.background).toBe("#ffffff");
    // ein Client, der r2 noch in Version 1 hat, belebt es nicht wieder
    expect(await applyBoardUpdate(h.db, storage, board, "u-lea.schaefer", [el("r2", 1, { index: "a1" })])).toMatchObject({ changed: 0 });
  });

  it("Ungültiges wird einzeln verworfen, der Rest gilt (P312-01); Grenzen: Anzahl, volle Tafel, Rate, ~30 gleichzeitig", async () => {
    for (const bad of [undefined, "x", []]) {
      expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", bad), JSON.stringify(bad)).toEqual({ ok: false, error: "invalid" });
    }
    expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [{ id: "a" }])).toMatchObject({ ok: true, changed: 0, dropped: 1 });
    // Web-Einbettung im selben Bündel wie ein gültiges Rechteck: das Rechteck kommt an
    const mixed = await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("ok", 5), { ...el("emb", 1), type: "embeddable", link: "https://x.de" }, { ...el("img", 1), type: "image", fileId: "f" }]);
    expect(mixed).toMatchObject({ ok: true, changed: 1, dropped: 2 });
    const sync = await syncBoard(h.db, storage, board, "u-jana.brandt");
    if (typeof sync === "string") throw new Error(sync);
    expect(sync.elements.map((e) => e.id)).toContain("ok");
    expect(sync.elements.map((e) => e.id)).not.toContain("emb");

    const many = Array.from({ length: LIMITS.updateElements + 1 }, (_, i) => el(`m${i}`, 1));
    expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", many)).toEqual({ ok: false, error: "too-many" });

    const sceneBytes = LIMITS.sceneBytes;
    LIMITS.sceneBytes = 4000;
    try {
      const big = (id: string) => el(id, 1, { type: "text", text: "x".repeat(1500) });
      expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [big("t1")])).toMatchObject({ ok: true });
      expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [big("t2"), big("t3")])).toEqual({ ok: false, error: "board-full" });
      // verkleinern/löschen geht weiter
      expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("t1", 2, { type: "text", text: "x", isDeleted: true })])).toMatchObject({ ok: true, changed: 1 });
    } finally {
      LIMITS.sceneBytes = sceneBytes;
    }

    const now = Date.now() + 120_000;
    let last;
    for (let i = 0; i <= LIMITS.updatesPerMinute; i++) last = await applyBoardUpdate(h.db, storage, board, "u-lea.schaefer", [el("rate", i + 1)], now);
    expect(last).toEqual({ ok: false, error: "rate" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let crowd;
    for (let i = 0; i < LIMITS.editors + 1; i++) crowd = await syncBoard(h.db, storage, board, `u-gast-${i}`, now);
    expect(crowd).toMatchObject({ crowded: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gleichzeitig die Tafel"));
  });

  it("zwei Prozesse speichern gleichzeitig: die fremde Fassung wird zusammengeführt und an die Anwesenden nachgeliefert", async () => {
    await flushBoards(h.db, storage, board);
    // „anderer Prozess“: schreibt eine neue Fassung mit einem eigenen Element und neuerem r1
    const before = await stored(board);
    const theirs = [...before.scene.elements.filter((e) => e.id !== "r1"), el("r1", 9, { width: 90 }), el("fremd", 1, { index: "b0" })];
    const key = newStorageKey();
    await storage.put(key, new TextEncoder().encode(serializeScene(theirs)));
    await h.db.update(fileNodes).set({ storageKey: key }).where(eq(fileNodes.id, board));

    const got: LiveEvent[] = [];
    const off = subscribe("u-jana.brandt", (e) => got.push(e));
    try {
      await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("mein", 1, { index: "c0" })]);
      await flushBoards(h.db, storage, board);
    } finally {
      off();
    }
    const after = await stored(board);
    const ids = after.scene.elements.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["fremd", "mein", "r1"]));
    expect(after.scene.elements.find((e) => e.id === "r1")!.width).toBe(90);
    const pushed = got.flatMap((e) => (e.type === "tafel" ? e.elements.map((x) => x.id) : []));
    expect(pushed).toEqual(expect.arrayContaining(["mein", "fremd", "r1"]));
  });

  it("in Dateien gelöscht bzw. umbenannt: Speicher vergisst die Tafel, nichts wird wieder angelegt", async () => {
    const jana = await p("u-jana.brandt");
    const id = await createBoard(h.db, storage, jana, { title: "Weg damit", groupId: "g-7b" });
    await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("z", 1)]);
    // Löschen in Dateien und Speichern gleichzeitig (P312-08): danach bleibt keine Fassung ohne Zeile im Speicher
    const keysBefore = new Set((await storage.list()).map((f) => f.key));
    keysBefore.delete((await stored(id)).key); // die Fassung der Tafel selbst muss mit weg
    await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("z", 2)]);
    await Promise.all([flushBoards(h.db, storage, id), deleteNode(h.db, storage, jana, "group:g-7b", id)]);
    await flushBoards(h.db, storage, id);
    const referenced = new Set((await h.db.select({ key: fileNodes.storageKey }).from(fileNodes)).map((r) => r.key));
    const orphans = (await storage.list()).map((f) => f.key).filter((k) => !referenced.has(k) && !keysBefore.has(k));
    expect(orphans).toEqual([]);
    expect(openBoardIds()).not.toContain(id);
    expect(await h.db.select().from(fileNodes).where(eq(fileNodes.id, id))).toEqual([]);
    expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("z", 2)])).toEqual({ ok: false, error: "missing" });

    const id2 = await createBoard(h.db, storage, jana, { title: "Umbenannt", groupId: "g-7b" });
    await renameNode(h.db, jana, "group:g-7b", id2, "Umbenannt.txt");
    expect(await boardAccess(h.db, jana, id2)).toBeNull();
    expect(await syncBoard(h.db, storage, id2, "u-jana.brandt")).toBe("missing");
  });

  it("gelöschte Inhalte landen weder in der Datei noch beim Sync (P312-03); Ablaufzeit vom Server (P312-06)", async () => {
    const id = await createBoard(h.db, storage, await p("u-jana.brandt"), { title: "Gelöscht", groupId: "g-7b" });
    const secret = { type: "text", text: "Beleidigung an Lea", originalText: "Beleidigung an Lea", link: "https://privat.example/lea" };
    await applyBoardUpdate(h.db, storage, id, "u-lea.schaefer", [el("t", 1, secret), el("pfeil", 1, { type: "arrow", points: [[0, 0], [40, 40]] })]);
    await flushBoards(h.db, storage, id);
    // sofort gelöscht – der Client schickt das ganze Element mit, Uhr des Rechners zwei Tage zurück
    const now = Date.now();
    const lateClock = now - 2 * 24 * 3600_000;
    await applyBoardUpdate(h.db, storage, id, "u-lea.schaefer", [el("t", 2, { ...secret, isDeleted: true, updated: lateClock })], now);
    await flushBoards(h.db, storage, id);

    const [row] = await h.db.select({ key: fileNodes.storageKey }).from(fileNodes).where(eq(fileNodes.id, id));
    const raw = (await readStored(storage, row!.key!, 1e7)) as string;
    expect(raw).not.toContain("Beleidigung");
    expect(raw).not.toContain("privat.example");
    const t = parseScene(raw)!.elements.find((e) => e.id === "t")!;
    expect(t).toMatchObject({ isDeleted: true, version: 2, updated: now }); // Serverzeit, nicht die Uhr des Clients
    const s = await syncBoard(h.db, storage, id, "u-jana.brandt");
    if (typeof s === "string") throw new Error(s);
    expect(JSON.stringify(s.elements)).not.toContain("Beleidigung");
    // falsche Uhr hätte den Grabstein sofort ablaufen lassen; mit Serverzeit bleibt er einen Tag, danach räumt der Sweep auf
    await sweep(h.db, storage, now + 3600_000);
    expect((await stored(id)).scene.elements.map((e) => e.id)).toEqual(["pfeil", "t"]);
    expect(openBoardIds()).not.toContain(id); // lange unbenutzt → aus dem Speicher; der Grabstein liegt noch in der Datei
    // nach einem Tag: beim nächsten Öffnen fällt er weg und die Datei wird neu geschrieben
    await syncBoard(h.db, storage, id, "u-jana.brandt", now + 25 * 3600_000);
    await flushBoards(h.db, storage, id);
    expect((await stored(id)).scene.elements.map((e) => e.id)).toEqual(["pfeil"]);
  });

  it("ältere Datei mit vollen Grabsteinen bzw. Client-Uhrzeit: beim Öffnen bereinigt und neu gespeichert", async () => {
    const future = Date.now() + 365 * 24 * 3600_000;
    const text = serializeScene([el("a", 1), el("weg", 3, { type: "text", text: "Alter Inhalt", isDeleted: true, updated: future })]);
    const key = newStorageKey();
    await storage.put(key, new TextEncoder().encode(text));
    const [n] = await h.db.insert(fileNodes).values({ kind: "file", name: "Alt.excalidraw", groupId: "g-7b", storageKey: key, size: text.length }).returning({ id: fileNodes.id });
    const now = Date.now();
    await syncBoard(h.db, storage, n!.id, "u-jana.brandt", now);
    await flushBoards(h.db, storage, n!.id);
    const after = await stored(n!.id);
    expect(after.key).not.toBe(key);
    const raw = (await readStored(storage, after.key, 1e7)) as string;
    expect(raw).not.toContain("Alter Inhalt");
    expect(after.scene.elements.find((e) => e.id === "weg")).toMatchObject({ isDeleted: true, updated: now });
  });

  it("Kontingent des Gruppenordners (P312-07): Wachstum darüber wird abgelehnt, Verkleinern geht; Speichern prüft unter Sperre", async () => {
    const id = await createBoard(h.db, storage, await p("u-jana.brandt"), { title: "Kontingent", groupId: "g-7b" });
    const quota = QUOTA.group;
    const used = await usage(h.db, { kind: "group", groupId: "g-7b" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      QUOTA.group = used + 1000;
      const look = { strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, roughness: 1, opacity: 100, seed: 42 };
      const t0 = Date.now() + 10 * 60_000; // eigener Zeitraum (Rate, Zwischenspeicher)
      expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("k1", 1, look)], t0)).toMatchObject({ ok: true, changed: 1 });
      expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("k2", 1, { type: "text", text: "x".repeat(1000) })], t0)).toEqual({ ok: false, error: "quota" });
      await flushBoards(h.db, storage, id);
      expect((await stored(id)).scene.elements.map((e) => e.id)).toEqual(["k1"]);

      // Zwischenspeicher sagt „passt“, inzwischen ist der Ordner voll (anderer Upload): das Speichern lehnt ab
      expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("k3", 1, look)], t0 + 1)).toMatchObject({ ok: true });
      QUOTA.group = used;
      await flushBoards(h.db, storage, id);
      expect((await stored(id)).scene.elements.map((e) => e.id)).toEqual(["k1"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Kontingent"));
      // danach keine Vergrößerung mehr, Löschen schon
      expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("k4", 1)], t0 + 2)).toEqual({ ok: false, error: "quota" });
      expect(await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("k3", 2, { isDeleted: true }), el("k1", 2, { isDeleted: true })], t0 + 3)).toMatchObject({ ok: true, changed: 2 });
      QUOTA.group = quota;
      await flushBoards(h.db, storage, id);
      expect((await stored(id)).scene.elements.every((e) => e.isDeleted)).toBe(true);
    } finally {
      QUOTA.group = quota;
    }
  });

  it("Sync ist begrenzt (30/min je Person und Tafel) und höchstens 50 Tafeln liegen im Speicher (P312-09)", async () => {
    const t0 = Date.now() + 20 * 60_000;
    let last;
    for (let i = 0; i <= LIMITS.syncsPerMinute; i++) last = await syncBoard(h.db, storage, board, "u-lea.schaefer", t0);
    expect(last).toBe("rate");
    expect(await syncBoard(h.db, storage, board, "u-jana.brandt", t0)).toMatchObject({ background: "#ffffff" }); // andere Person
    expect(await syncBoard(h.db, storage, board, "u-lea.schaefer", t0 + 60_000)).toMatchObject({ background: "#ffffff" }); // nächste Minute

    const loaded = LIMITS.loadedBoards;
    const jana = await p("u-jana.brandt");
    try {
      await flushBoards(h.db, storage);
      LIMITS.loadedBoards = 2;
      const t1 = Date.now() + 3 * 24 * 3600_000; // nach allen bisherigen Zugriffen (auch den „einen Tag später“ oben)
      const ids = [];
      for (const title of ["L1", "L2", "L3"]) ids.push(await createBoard(h.db, storage, jana, { title, groupId: "g-7b" }));
      await syncBoard(h.db, storage, ids[0]!, "u-jana.brandt", t1 + 1);
      await syncBoard(h.db, storage, ids[1]!, "u-jana.brandt", t1 + 2);
      await syncBoard(h.db, storage, ids[2]!, "u-jana.brandt", t1 + 3);
      expect(openBoardIds()).toHaveLength(2);
      expect(openBoardIds()).toEqual(expect.arrayContaining([ids[1], ids[2]]));
      // ungesicherte Tafeln fallen nicht heraus
      await applyBoardUpdate(h.db, storage, ids[1]!, "u-jana.brandt", [el("u", 1)], t1 + 4);
      await syncBoard(h.db, storage, ids[0]!, "u-jana.brandt", t1 + 5);
      expect(openBoardIds()).toEqual(expect.arrayContaining([ids[0], ids[1]]));
      expect(openBoardIds()).not.toContain(ids[2]);
    } finally {
      LIMITS.loadedBoards = loaded;
    }
  });

  it("kaputte oder zu große Datei: öffnen scheitert sauber", async () => {
    const put = async (name: string, data: string) => {
      const key = newStorageKey();
      await storage.put(key, new TextEncoder().encode(data));
      const [n] = await h.db.insert(fileNodes).values({ kind: "file", name, groupId: "g-7b", storageKey: key, size: data.length }).returning({ id: fileNodes.id });
      return n!.id;
    };
    expect(await syncBoard(h.db, storage, await put("Kaputt.excalidraw", "{nicht json"), "u-jana.brandt")).toBe("invalid-file");
    const sceneBytes = LIMITS.sceneBytes;
    LIMITS.sceneBytes = 100;
    try {
      expect(await syncBoard(h.db, storage, await put("Gross.excalidraw", serializeScene([el("a", 1), el("b", 1)])), "u-jana.brandt")).toBe("too-large");
    } finally {
      LIMITS.sceneBytes = sceneBytes;
    }
    // Fremddatei mit Bildern: Bilder fallen weg, der Rest lässt sich öffnen
    const withImage = JSON.stringify({ type: "excalidraw", elements: [el("a", 1), { ...el("i", 1), type: "image", fileId: "f" }], files: { f: { dataURL: "data:image/png;base64,AAAA" } } });
    const s = await syncBoard(h.db, storage, await put("Fremd.excalidraw", withImage), "u-jana.brandt");
    if (typeof s === "string") throw new Error(s);
    expect(s.elements.map((e) => e.id)).toEqual(["a"]);
  });

  it("G3B-01: Zusatzfelder, an denen Excalidraw abstürzt, kommen weder zu den anderen noch in die Datei", async () => {
    const got: LiveEvent[] = [];
    const off = subscribe("u-lea.schaefer", (e) => got.push(e));
    try {
      await syncBoard(h.db, storage, board, "u-lea.schaefer");
      const r = await applyBoardUpdate(h.db, storage, board, "u-lea.schaefer", [
        { ...el("boese1", 1), boundElementIds: 1, customData: { x: 1 } },
        el("boese2", 1, { type: "text", text: "Hallo", font: 1 }),
      ]);
      expect(r).toMatchObject({ ok: true, changed: 2, dropped: 0 });
      const ev = got.find((e) => e.type === "tafel");
      if (ev?.type !== "tafel") throw new Error("kein Ereignis");
      expect(JSON.stringify(ev.elements)).not.toMatch(/boundElementIds|"font"|customData/);
      expect(ev.elements.find((e) => e.id === "boese2")).toMatchObject({ text: "Hallo" });
    } finally {
      off();
    }
    await flushBoards(h.db, storage, board);
    const raw = JSON.stringify((await stored(board)).scene.elements);
    expect(raw).toContain("boese1");
    expect(raw).not.toMatch(/boundElementIds|"font"|customData/);
  });

  it("G3B-02: Versionssprung je Update begrenzt; Verworfenes wird mit Kennung gemeldet; Löschen bleibt möglich", async () => {
    expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("sprung", 1)])).toMatchObject({ ok: true, changed: 1 });
    const r = await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [
      el("sprung", 2 + LIMITS.versionStep),
      el("neuhoch", LIMITS.versionStep + 1),
      el("riesig", Number.MAX_SAFE_INTEGER, { versionNonce: -Number.MAX_SAFE_INTEGER }),
      { id: "kaputt", type: "rectangle" },
      { id: "../x" },
    ]);
    expect(r).toMatchObject({ ok: true, changed: 0, dropped: 5, droppedIds: ["sprung", "neuhoch", "riesig", "kaputt"] });
    // innerhalb der Grenze geht es, und die Lehrkraft kann das Element löschen
    expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("sprung", 1 + LIMITS.versionStep)])).toMatchObject({ changed: 1 });
    expect(await applyBoardUpdate(h.db, storage, board, "u-jana.brandt", [el("sprung", 2 + LIMITS.versionStep, { isDeleted: true })])).toMatchObject({ changed: 1 });
    const s = await syncBoard(h.db, storage, board, "u-jana.brandt");
    if (typeof s === "string") throw new Error(s);
    expect(s.elements.find((e) => e.id === "sprung")).toMatchObject({ isDeleted: true });
    expect(s.elements.map((e) => e.id)).not.toContain("neuhoch");
  });

  it("G3B-03: Restplatz gilt je Gruppe (zwei Tafeln verplanen nicht denselben Rest); scheitert das Speichern, erfahren es die Anwesenden", async () => {
    const jana = await p("u-jana.brandt");
    const a = await createBoard(h.db, storage, jana, { title: "Rest A", groupId: "g-7b" });
    const b = await createBoard(h.db, storage, jana, { title: "Rest B", groupId: "g-7b" });
    await flushBoards(h.db, storage);
    const quota = QUOTA.group;
    const used = await usage(h.db, { kind: "group", groupId: "g-7b" });
    const t = Date.now() + 6 * 24 * 3600_000; // nach allen bisherigen Zeitpunkten (Rate, Zwischenspeicher)
    clearQuotaCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const got: LiveEvent[] = [];
    const off = subscribe("u-lea.schaefer", (e) => got.push(e));
    try {
      QUOTA.group = used + 3000;
      const big = (id: string) => el(id, 1, { type: "text", text: "x".repeat(1800) });
      expect(await applyBoardUpdate(h.db, storage, a, "u-jana.brandt", [big("ga")], t)).toMatchObject({ ok: true, changed: 1 });
      // vorher: Tafel B prüfte gegen denselben zwischengespeicherten Rest und nahm ebenfalls an
      expect(await applyBoardUpdate(h.db, storage, b, "u-jana.brandt", [big("gb")], t + 1)).toEqual({ ok: false, error: "quota" });
      await flushBoards(h.db, storage);
      expect((await stored(a)).scene.elements.map((e) => e.id)).toEqual(["ga"]);

      // angenommen, dann scheitert das Speichern (Ordner inzwischen voll): Meldung an die Anwesenden und im Sync
      await syncBoard(h.db, storage, a, "u-lea.schaefer", t + 2);
      expect(await applyBoardUpdate(h.db, storage, a, "u-jana.brandt", [el("klein", 1)], t + 3)).toMatchObject({ ok: true, changed: 1 });
      QUOTA.group = 0;
      got.length = 0;
      await flushBoards(h.db, storage, a);
      expect(got).toContainEqual({ type: "tafel", boardId: a, elements: [], notSaved: true });
      expect(got.filter((e) => e.type === "tafel")).toHaveLength(1); // nur einmal, nicht bei jedem Versuch
      expect(await syncBoard(h.db, storage, a, "u-lea.schaefer", t + 4)).toMatchObject({ notSaved: true });
      QUOTA.group = quota;
      await flushBoards(h.db, storage, a);
      expect(got).toContainEqual({ type: "tafel", boardId: a, elements: [], notSaved: false });
      expect(await syncBoard(h.db, storage, a, "u-lea.schaefer", t + 5)).toMatchObject({ notSaved: false });
      expect((await stored(a)).scene.elements.map((e) => e.id)).toEqual(["ga", "klein"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Kontingent"));
    } finally {
      off();
      QUOTA.group = quota;
      clearQuotaCache();
    }
  });

  it("Sweep speichert Ungesichertes und nimmt lange Ungenutztes aus dem Speicher", async () => {
    const id = await createBoard(h.db, storage, await p("u-jana.brandt"), { title: "Sweep", groupId: "g-7b" });
    LIMITS.saveDelayMs = 60_000;
    try {
      await applyBoardUpdate(h.db, storage, id, "u-jana.brandt", [el("s", 1)]);
      forgetTimer(id);
      await sweep(h.db, storage);
      expect((await stored(id)).scene.elements.map((e) => e.id)).toEqual(["s"]);
      await sweep(h.db, storage, Date.now() + LIMITS.idleMs + 1000);
      expect(openBoardIds()).not.toContain(id);
    } finally {
      LIMITS.saveDelayMs = 30;
    }
  });
});

/** zwischengespeicherten Restplatz aller Gruppen vergessen */
function clearQuotaCache() {
  (globalThis as unknown as { __schulosTafeln: { quota: Map<string, unknown> } }).__schulosTafeln.quota.clear();
}

/** Timer eines offenen Boards stoppen, damit der Sweep das Speichern übernimmt */
function forgetTimer(id: string) {
  const store = (globalThis as unknown as { __schulosTafeln: { boards: Map<string, { saveTimer: ReturnType<typeof setTimeout> | null }> } }).__schulosTafeln;
  const ob = store.boards.get(id)!;
  if (ob.saveTimer) clearTimeout(ob.saveTimer);
  ob.saveTimer = null;
}
