import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { boards, fileNodes, monitorScreens } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { createScreen, monitorData } from "@/modules/monitor/service";
import { addBoardMember, addCard, addColumn, approveCard, boardForMonitor, createBoard, deleteCard, deleteColumn, getBoard, listBoards, monitorBoards, moveCard, updateBoard } from "./service";

describe("Pinnwände", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Pinnwand der Gruppe: Mitglieder sehen sie, Fremde nicht; Karte geht live an alle", async () => {
    const lea = await p("u-lea.schaefer");
    expect((await listBoards(h.db, lea)).map((b) => b.id)).toContain("board-7b-projekt");
    expect(await getBoard(h.db, await p("u-daniel.okafor"), "board-7b-projekt")).toBeNull();

    const events: LiveEvent[] = [];
    const off = subscribe("u-jana.brandt", (e) => events.push(e));
    const id = await addCard(h.db, lea, "board-7b-projekt", { columnId: "col-7b-ideen", kind: "text", title: "Licht aus in der Pause", body: "" });
    off();
    expect(events).toEqual([{ type: "board", boardId: "board-7b-projekt" }]);
    const board = (await getBoard(h.db, lea, "board-7b-projekt"))!;
    expect(board.role).toBe("member");
    expect(board.columns[0]!.cards.map((c) => [c.title, c.mine])).toEqual([
      ["Energie sparen in der Schule", false],
      ["Licht aus in der Pause", true],
    ]);
    await expect(deleteCard(h.db, await p("u-daniel.okafor"), id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteCard(h.db, lea, id);
  });

  it("Modus: nur Leitung bzw. moderiert mit Freigabe", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    await updateBoard(h.db, jana, "board-7b-projekt", { title: "Projekt Klimaschutz", mode: "leitung" });
    await expect(addCard(h.db, lea, "board-7b-projekt", { columnId: "col-7b-ideen", kind: "text", title: "x", body: "" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getBoard(h.db, lea, "board-7b-projekt"))!.canPost).toBe(false);

    await updateBoard(h.db, jana, "board-7b-projekt", { title: "Projekt Klimaschutz", mode: "moderiert" });
    const pending = await addCard(h.db, lea, "board-7b-projekt", { columnId: "col-7b-ideen", kind: "text", title: "Solardach", body: "" });
    const titles = async (uid: string) => (await getBoard(h.db, await p(uid), "board-7b-projekt"))!.columns[0]!.cards.map((c) => c.title);
    expect(await titles("u-lea.schaefer")).toContain("Solardach");
    expect(await titles("u-jana.brandt")).toContain("Solardach");
    const other = (await getBoard(h.db, jana, "board-7b-projekt"))!;
    expect(other.columns[0]!.cards.find((c) => c.title === "Solardach")!.approved).toBe(false);
    await expect(approveCard(h.db, lea, pending)).rejects.toBeInstanceOf(ForbiddenError);
    await approveCard(h.db, jana, pending);
    await updateBoard(h.db, jana, "board-7b-projekt", { title: "Projekt Klimaschutz", mode: "alle" });
  });

  it("Karten prüfen: Link nur http(s), Datei nur aus dem eigenen Gruppenordner", async () => {
    const lea = await p("u-lea.schaefer");
    const base = { columnId: "col-7b-quellen", title: "Quelle", body: "" };
    await expect(addCard(h.db, lea, "board-7b-projekt", { ...base, kind: "link", url: "javascript:alert(1)" })).rejects.toBeInstanceOf(ValidationError);
    await addCard(h.db, lea, "board-7b-projekt", { ...base, kind: "link", url: "https://example.org/klima" });
    const [own] = await h.db.insert(fileNodes).values({ kind: "file", name: "plakat.png", groupId: "g-7b", mime: "image/png", size: 1, storageKey: "x" }).returning();
    const [foreign] = await h.db.insert(fileNodes).values({ kind: "file", name: "fremd.png", groupId: "g-9a", mime: "image/png", size: 1, storageKey: "y" }).returning();
    await expect(addCard(h.db, lea, "board-7b-projekt", { ...base, kind: "file", fileId: foreign!.id })).rejects.toBeInstanceOf(ValidationError);
    await addCard(h.db, lea, "board-7b-projekt", { ...base, kind: "file", fileId: own!.id });
    const quellen = (await getBoard(h.db, lea, "board-7b-projekt"))!.columns[1]!.cards;
    expect(quellen.find((c) => c.kind === "file")).toMatchObject({ fileName: "plakat.png", fileMime: "image/png" });
    await h.db.delete(fileNodes).where(eq(fileNodes.id, foreign!.id));
  });

  it("P3-09: Karten verschieben – innerhalb und zwischen Spalten, lückenlose Positionen; Mitglieder nur eigene", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    const id = await createBoard(h.db, jana, { title: "Sortieren", mode: "alle", groupId: "g-7b" });
    await addColumn(h.db, jana, id, "Rechts");
    const [left, right] = (await getBoard(h.db, jana, id))!.columns;
    const a = await addCard(h.db, jana, id, { columnId: left!.id, kind: "text", title: "A", body: "" });
    const b = await addCard(h.db, jana, id, { columnId: left!.id, kind: "text", title: "B", body: "" });
    const c = await addCard(h.db, lea, id, { columnId: left!.id, kind: "text", title: "C", body: "" });
    const order = async () => (await getBoard(h.db, jana, id))!.columns.map((col) => col.cards.map((x) => `${x.title}${x.position}`).join(","));

    await moveCard(h.db, jana, c, left!.id, 0);
    expect(await order()).toEqual(["C0,A1,B2", ""]);
    await moveCard(h.db, lea, c, right!.id, 0);
    expect(await order()).toEqual(["A0,B1", "C0"]);
    await moveCard(h.db, jana, b, right!.id, 99);
    expect(await order()).toEqual(["A0", "C0,B1"]);
    await expect(moveCard(h.db, lea, a, right!.id, 0)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Review 2026-10-10: Verschieben zählt in der Liste, die das Mitglied sieht (fremde Karten in Freigabe zählen nicht)", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    const id = await createBoard(h.db, jana, { title: "Moderiert", mode: "moderiert", groupId: "g-7b" });
    const [col] = (await getBoard(h.db, jana, id))!.columns;
    const mine = await addCard(h.db, lea, id, { columnId: col!.id, kind: "text", title: "M", body: "" });
    await addCard(h.db, await p("u-anton.kaya"), id, { columnId: col!.id, kind: "text", title: "P", body: "" });
    const a = await addCard(h.db, jana, id, { columnId: col!.id, kind: "text", title: "A", body: "" });
    expect(a).toBeTruthy();
    const seen = async () => (await getBoard(h.db, lea, id))!.columns[0]!.cards.map((x) => x.title).join(",");
    expect(await seen()).toBe("M,A");
    await moveCard(h.db, lea, mine, col!.id, 1);
    expect(await seen()).toBe("A,M");
  });

  it("P3-09: Monitor zeigt nur freigegebene Pinnwände, nur freigegebene Karten, ohne Namen", async () => {
    const jana = await p("u-jana.brandt");
    expect(await boardForMonitor(h.db, "board-7b-projekt")).toBeNull();
    await expect(createScreen(h.db, "u-admin", { name: "Foyer", location: "", profile: "foyer", boardId: "board-7b-projekt" })).rejects.toBeInstanceOf(ValidationError);
    await updateBoard(h.db, jana, "board-7b-projekt", { title: "Projekt Klimaschutz", mode: "moderiert", onMonitor: true });
    await addCard(h.db, await p("u-lea.schaefer"), "board-7b-projekt", { columnId: "col-7b-ideen", kind: "text", title: "Noch nicht frei", body: "" });
    const shown = (await boardForMonitor(h.db, "board-7b-projekt"))!;
    expect(shown.columns[0]!.cards.map((c) => c.title)).not.toContain("Noch nicht frei");
    expect(JSON.stringify(shown)).not.toContain("Brandt");
    expect(shown.columns[1]!.cards.find((c) => c.title === "Umweltbundesamt")?.link).toBe("www.umweltbundesamt.de");

    const { id } = await createScreen(h.db, "u-admin", { name: "Foyer", location: "", profile: "foyer", boardId: "board-7b-projekt" });
    const [screen] = await h.db.select().from(monitorScreens).where(eq(monitorScreens.id, id));
    expect((await monitorData(h.db, screen!)).board?.title).toBe("Projekt Klimaschutz");
    await updateBoard(h.db, jana, "board-7b-projekt", { title: "Projekt Klimaschutz", mode: "alle", onMonitor: false });
    expect((await monitorData(h.db, screen!)).board).toBeUndefined();
  });

  it("SEC-05: Monitor nur bei geprüften Karten – nicht im Modus „alle“; beim Wechsel warten Mitgliederkarten auf Freigabe", async () => {
    const jana = await p("u-jana.brandt");
    const lea = await p("u-lea.schaefer");
    const id = await createBoard(h.db, jana, { title: "Foyer-Test", mode: "alle", groupId: "g-7b" });
    await expect(updateBoard(h.db, jana, id, { title: "Foyer-Test", mode: "alle", onMonitor: true })).rejects.toMatchObject({ fieldErrors: { onMonitor: expect.any(String) } });
    const [col] = (await getBoard(h.db, jana, id))!.columns;
    await addCard(h.db, lea, id, { columnId: col!.id, kind: "text", title: "Ungeprüft", body: "" });
    await addCard(h.db, jana, id, { columnId: col!.id, kind: "text", title: "Von der Leitung", body: "" });
    expect((await getBoard(h.db, lea, id))!.columns[0]!.cards.find((c) => c.title === "Ungeprüft")!.approved).toBe(true);

    await updateBoard(h.db, jana, id, { title: "Foyer-Test", mode: "moderiert", onMonitor: true });
    const shown = (await boardForMonitor(h.db, id))!.columns[0]!.cards.map((c) => c.title);
    expect(shown).toEqual(["Von der Leitung"]);
    // Lea sieht ihre Karte weiter (wartet auf Freigabe), andere Mitglieder nicht mehr
    expect((await getBoard(h.db, lea, id))!.columns[0]!.cards.find((c) => c.title === "Ungeprüft")!.approved).toBe(false);
    expect((await getBoard(h.db, await p("u-anton.kaya"), id))!.columns[0]!.cards.map((c) => c.title)).toEqual(["Von der Leitung"]);

    // Altbestand (onMonitor und „alle“ gleichzeitig) erscheint nicht
    await h.db.update(boards).set({ mode: "alle" }).where(eq(boards.id, id));
    expect(await boardForMonitor(h.db, id)).toBeNull();
    expect((await monitorBoards(h.db)).map((b) => b.id)).not.toContain(id);
  });

  it("freie Pinnwand: anlegen mit Recht, Mitglieder per Benutzername, Spalten nur leer löschen", async () => {
    await expect(createBoard(h.db, await p("u-lea.schaefer"), { title: "Meins", mode: "alle", groupId: null })).rejects.toBeInstanceOf(ForbiddenError);
    const jana = await p("u-jana.brandt");
    const id = await createBoard(h.db, jana, { title: "Fachschaft Deutsch – Lektüren", mode: "alle", groupId: null });
    expect(await getBoard(h.db, await p("u-daniel.okafor"), id)).toBeNull();
    await addBoardMember(h.db, jana, id, "daniel.okafor");
    await expect(addBoardMember(h.db, jana, id, "gibt.es.nicht")).rejects.toBeInstanceOf(ValidationError);
    const asDaniel = (await getBoard(h.db, await p("u-daniel.okafor"), id))!;
    expect(asDaniel.role).toBe("member");
    expect((await listBoards(h.db, await p("u-daniel.okafor"))).map((b) => b.id)).toContain(id);
    await expect(addColumn(h.db, await p("u-daniel.okafor"), id, "Neu")).rejects.toBeInstanceOf(ForbiddenError);

    await addColumn(h.db, jana, id, "Klasse 8");
    const [first, second] = (await getBoard(h.db, jana, id))!.columns;
    await addCard(h.db, await p("u-daniel.okafor"), id, { columnId: first!.id, kind: "text", title: "Tschick", body: "" });
    await expect(deleteColumn(h.db, jana, first!.id)).rejects.toBeInstanceOf(ValidationError); // hat Karten
    await deleteColumn(h.db, jana, second!.id); // leer
    await expect(deleteColumn(h.db, jana, first!.id)).rejects.toBeInstanceOf(ValidationError); // letzte Spalte
    expect((await getBoard(h.db, jana, id))!.columns.map((c) => c.title)).toEqual(["Allgemein"]);

    // Gruppenpinnwand nur für Leitung/Personal der Gruppe
    await expect(createBoard(h.db, await p("u-lea.schaefer"), { title: "x", mode: "alle", groupId: "g-7b" })).rejects.toBeInstanceOf(ForbiddenError);
    await createBoard(h.db, jana, { title: "Lesekiste", mode: "alle", groupId: "g-7b" });
  });
});
