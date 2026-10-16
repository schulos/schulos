import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { groupMembers } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "@/core/notifications/bus";
import { loadPermissions } from "@/core/permissions";
import { listUsers, ValidationError } from "@/modules/verwaltung/users";
import { readModuleSetting, writeModuleSetting } from "@/core/modules/settings";
import { directPartnerBlock, getRoom, listMessages, listRooms, markRead, openDirectRoom, sendMessage, unreadTotal } from "./service";
import { isCounselingPair } from "./policy";
import { COUNSELING_CHAT, STUDENT_DIRECT } from "./settings";
import { sql } from "drizzle-orm";
import { rowsOf } from "@/core/db/rows";
import messengerManifest from "./manifest";

describe("Messenger", () => {
  let h: DbHandle;
  let fremd: string;
  let mitschueler: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    fremd = (await listUsers(h.db, { groupId: "g-9a", role: "schueler" })).rows[0]!.id;
    mitschueler = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.find((r) => r.id !== "u-lea.schaefer")!.id;
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);

  it("Raumliste: Gruppenchats der eigenen Gruppen, zuletzt aktive zuerst, mit Ungelesen", async () => {
    const rooms = await listRooms(h.db, await p("u-lea.schaefer"));
    expect(rooms.map((r) => r.title)).toEqual(expect.arrayContaining(["Klasse 7b", "AG Schülerzeitung"]));
    expect(rooms[0]?.title).toBe("AG Schülerzeitung"); // jüngste Nachricht
    expect(rooms.find((r) => r.title === "Klasse 7b")?.unread).toBe(1);
    expect(rooms.find((r) => r.title === "AG Schülerzeitung")?.unread).toBe(0); // eigene Nachricht + gelesen
    expect(await unreadTotal(h.db, await p("u-lea.schaefer"))).toBe(1);
  });

  it("Zugriff nur für Mitglieder", async () => {
    expect(await listMessages(h.db, await p(fremd), "room-g-7b")).toBeNull();
    await expect(sendMessage(h.db, await p(fremd), "room-g-7b", "Hallo?")).rejects.toThrow(ValidationError);
  });

  it("Nachricht wird live an alle Mitglieder zugestellt (inkl. eigener anderer Tabs)", async () => {
    const seen: Record<string, LiveEvent[]> = { lea: [], mit: [], fremd: [] };
    const offs = [
      subscribe("u-lea.schaefer", (e) => seen.lea!.push(e)),
      subscribe(mitschueler, (e) => seen.mit!.push(e)),
      subscribe(fremd, (e) => seen.fremd!.push(e)),
    ];
    const msg = await sendMessage(h.db, await p("u-lea.schaefer"), "room-g-7b", "  Wer hat die Hausaufgaben?  ");
    offs.forEach((o) => o());
    expect(msg.body).toBe("Wer hat die Hausaufgaben?");
    expect(seen.mit!.some((e) => e.type === "chat" && e.message.id === msg.id)).toBe(true);
    expect(seen.lea!.some((e) => e.type === "chat")).toBe(true);
    expect(seen.fremd).toEqual([]);
    expect((await listMessages(h.db, await p(mitschueler), "room-g-7b"))!.at(-1)?.authorName).toBe("Lea Schäfer");
  });

  it("Senden markiert den Raum als gelesen; markRead senkt den Zähler", async () => {
    expect(await unreadTotal(h.db, await p("u-lea.schaefer"))).toBe(0);
    const mit = await p(mitschueler);
    expect((await listRooms(h.db, mit)).find((r) => r.id === "room-g-7b")?.unread).toBe(2);
    await markRead(h.db, mit, "room-g-7b");
    expect((await listRooms(h.db, mit)).find((r) => r.id === "room-g-7b")?.unread).toBe(0);
  });

  it("Direktchat: nur mit sichtbaren Personen, genau ein Raum pro Paar, Lesestatus", async () => {
    const lea = await p("u-lea.schaefer");
    await expect(openDirectRoom(h.db, lea, fremd)).rejects.toThrow(ValidationError); // fremde Klasse
    await expect(openDirectRoom(h.db, lea, "u-lea.schaefer")).rejects.toThrow(ValidationError);
    const r1 = await openDirectRoom(h.db, lea, "u-jana.brandt");
    const r2 = await openDirectRoom(h.db, await p("u-jana.brandt"), "u-lea.schaefer");
    expect(r2).toBe(r1);
    await sendMessage(h.db, lea, r1, "Frage zur Erörterung");
    const brandtRooms = await listRooms(h.db, await p("u-jana.brandt"));
    expect(brandtRooms.find((r) => r.id === r1)).toMatchObject({ kind: "direct", title: "Lea Schäfer", unread: 1 });
    await markRead(h.db, await p("u-jana.brandt"), r1);
    const room = await getRoom(h.db, lea, r1);
    expect(room?.title).toBe("Jana Brandt");
    expect(room?.reads.find((r) => r.userId === "u-jana.brandt")).toBeTruthy();
  });

  it("validiert Nachrichten", async () => {
    const lea = await p("u-lea.schaefer");
    await expect(sendMessage(h.db, lea, "room-g-7b", "   ")).rejects.toThrow(ValidationError);
    await expect(sendMessage(h.db, lea, "room-g-7b", "x".repeat(4001))).rejects.toThrow(ValidationError);
  });
});

describe("Messenger – Ereignisreihenfolge & Avatare", () => {
  it("beim Senden kommt chat-read (mit unreadTotal) NACH dem chat-Ereignis", async () => {
    const h = await createSeededTestDb();
    const lea = await loadPermissions(h.db, "u-lea.schaefer");
    const order: string[] = [];
    const off = subscribe("u-lea.schaefer", (e) => order.push(e.type === "chat-read" && e.unreadTotal !== undefined ? "chat-read+total" : e.type));
    await sendMessage(h.db, lea, "room-g-7b", "Test");
    off();
    expect(order.indexOf("chat")).toBeLessThan(order.lastIndexOf("chat-read+total"));
    const rooms = await listRooms(h.db, lea);
    expect(rooms.find((r) => r.title === "Klasse 7b")?.avatar).toBe("7B");
    expect(rooms.find((r) => r.title === "AG Schülerzeitung")?.avatar).toBe("AS");
    await h.close();
  }, 60_000);
});

describe("Messenger: Direktchats unter Schüler:innen (Moduleinstellung, Q5-14)", () => {
  let h: DbHandle;
  let klasse: string;
  let agOhneKlasse: string;
  beforeAll(async () => {
    h = await createSeededTestDb();
    klasse = (await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.find((r) => r.id !== "u-lea.schaefer")!.id;
    const in7b = new Set((await listUsers(h.db, { groupId: "g-7b", role: "schueler" })).rows.map((r) => r.id));
    agOhneKlasse = (await listUsers(h.db, { groupId: "g-ag-schuelerzeitung", role: "schueler" })).rows.find((r) => !in7b.has(r.id))!.id;
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);

  it("Vorgabe „nur eigene Klasse“: Klassenkamerad ja, AG-Mitglied aus anderer Klasse nein", async () => {
    const lea = await p("u-lea.schaefer");
    expect(await readModuleSetting(h.db, STUDENT_DIRECT)).toBe("klasse");
    await openDirectRoom(h.db, lea, klasse);
    await expect(openDirectRoom(h.db, lea, agOhneKlasse)).rejects.toMatchObject({ fieldErrors: { user: expect.stringMatching(/eigenen Klasse/) } });
    // Lehrkräfte sind nicht betroffen
    await expect(openDirectRoom(h.db, lea, "u-jana.brandt")).resolves.toBeTruthy();
  });

  it("„gemeinsame Gruppen“ erlaubt das AG-Mitglied; „aus“ sperrt auch das Schreiben im bestehenden Chat", async () => {
    const lea = await p("u-lea.schaefer");
    await writeModuleSetting(h.db, STUDENT_DIRECT, "gruppen");
    const room = await openDirectRoom(h.db, lea, agOhneKlasse);
    await sendMessage(h.db, lea, room, "Treffen wir uns in der Pause?");
    await writeModuleSetting(h.db, STUDENT_DIRECT, "aus");
    await expect(sendMessage(h.db, lea, room, "Noch da?")).rejects.toMatchObject({ fieldErrors: { body: expect.stringMatching(/ausgeschaltet/) } });
    expect(await directPartnerBlock(h.db, lea, room)).toMatch(/ausgeschaltet/);
    expect((await listMessages(h.db, lea, room))?.length).toBe(1); // lesen bleibt
    await expect(openDirectRoom(h.db, lea, klasse)).rejects.toThrow(ValidationError);
    const lk = await openDirectRoom(h.db, lea, "u-jana.brandt");
    await expect(sendMessage(h.db, lea, lk, "Frage an die Lehrkraft")).resolves.toBeTruthy();
    await writeModuleSetting(h.db, STUDENT_DIRECT, "klasse");
  });
});

describe("Messenger: Chats mit der Schulsozialarbeit (Rolle Beratung, Q5-17)", () => {
  const NINA = "u-nina.ostermann";
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());
  const p = (id: string) => loadPermissions(h.db, id);

  it("Vorgabe aus (DSB-Votum offen): weder Schülerin noch Beratung können einen Chat beginnen", async () => {
    expect(await readModuleSetting(h.db, COUNSELING_CHAT)).toBe("aus");
    await expect(openDirectRoom(h.db, await p("u-lea.schaefer"), NINA)).rejects.toMatchObject({ fieldErrors: { user: expect.stringMatching(/nicht freigeschaltet/) } });
    // Lehrkräfte und Beratung chatten normal
    await expect(openDirectRoom(h.db, await p("u-jana.brandt"), NINA)).resolves.toBeTruthy();
  });

  it("eingeschaltet: nur Schüler:innen/Eltern beginnen; Hinweis-Paarung; wieder aus sperrt das Schreiben", async () => {
    await writeModuleSetting(h.db, COUNSELING_CHAT, "an");
    const lea = await p("u-lea.schaefer");
    const nina = await p(NINA);
    // Beratung kann niemanden aus der 7b anschreiben, auch nicht über eine gemeinsame Gruppe
    await h.db.insert(groupMembers).values({ groupId: "g-ag-schuelerzeitung", userId: NINA });
    const ninaInAg = await p(NINA);
    await expect(openDirectRoom(h.db, ninaInAg, "u-lea.schaefer")).rejects.toMatchObject({ fieldErrors: { user: expect.stringMatching(/schreiben zuerst/) } });
    const room = await openDirectRoom(h.db, lea, NINA);
    await sendMessage(h.db, lea, room, "Kann ich Dienstag in der Pause kommen?");
    // jetzt besteht der Chat – die Beratung antwortet und findet ihn auch über openDirectRoom
    expect(await openDirectRoom(h.db, nina, "u-lea.schaefer")).toBe(room);
    await sendMessage(h.db, nina, room, "Ja, 10:15 Uhr in A 0.14.");
    expect(isCounselingPair("schueler", "beratung")).toBe(true);
    expect(isCounselingPair("lehrkraft", "beratung")).toBe(false);
    await writeModuleSetting(h.db, COUNSELING_CHAT, "aus");
    await expect(sendMessage(h.db, nina, room, "Noch da?")).rejects.toThrow(ValidationError);
    expect((await listMessages(h.db, lea, room))?.length).toBe(2);
  });
});

describe("Messenger: Löschregel Schulsozialarbeit (GATE-031 C-05)", () => {
  const NINA = "u-nina.ostermann";
  let h: DbHandle;
  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("LK-90 nur für Direktchats Beratung ↔ Schüler:in/Eltern, nicht Beratung ↔ Lehrkraft", async () => {
    await writeModuleSetting(h.db, COUNSELING_CHAT, "an");
    const withStudent = await openDirectRoom(h.db, await loadPermissions(h.db, "u-lea.schaefer"), NINA);
    const withTeacher = await openDirectRoom(h.db, await loadPermissions(h.db, "u-jana.brandt"), NINA);
    const rule = messengerManifest.retention!.find((r) => r.scope === "Direktchat mit der Schulsozialarbeit")!;
    expect(rule).toMatchObject({ class: "LK-90" });
    const hits = rowsOf<{ id: string }>(await h.db.execute(sql.raw(`select id from chat_rooms where ${(rule as { where: string }).where}`))).map((r) => r.id);
    expect(hits).toContain(withStudent);
    expect(hits).not.toContain(withTeacher);
  });
});
