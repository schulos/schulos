import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@/core/db/client";
import { users } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import { subscribe, type LiveEvent } from "./bus";
import { listNotifications, markRead, notify, notifyBundled, unreadCount } from "./index";

describe("Gong", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
    await h.db.insert(users).values([
      { id: "a", name: "A", email: "a@t" },
      { id: "b", name: "B", email: "b@t" },
    ]);
  });
  afterAll(() => h.close());

  it("benachrichtigt (ohne Duplikate) und pusht live an den richtigen Empfänger", async () => {
    const seenA: LiveEvent[] = [];
    const seenB: LiveEvent[] = [];
    const offA = subscribe("a", (e) => seenA.push(e));
    const offB = subscribe("b", (e) => seenB.push(e));
    expect(await notify(h.db, ["a", "a", "b"], { moduleId: "test", title: "Hallo", href: "/x" })).toBe(2);
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({ type: "notification", unread: 1, notification: { title: "Hallo", href: "/x", readAt: null } });
    expect(seenB).toHaveLength(1);
    offA();
    offB();
    await notify(h.db, ["a"], { moduleId: "test", title: "Zweite" });
    expect(seenA).toHaveLength(1); // abgemeldet
  });

  it("listet neueste zuerst und zählt Ungelesenes", async () => {
    const list = await listNotifications(h.db, "a");
    expect(list.map((n) => n.title)).toEqual(["Zweite", "Hallo"]);
    expect(await unreadCount(h.db, "a")).toBe(2);
  });

  it("markiert einzeln und alle als gelesen – nur eigene", async () => {
    const [first] = await listNotifications(h.db, "a");
    const [ofB] = await listNotifications(h.db, "b");
    expect(await markRead(h.db, "a", [first!.id, ofB!.id])).toBe(1);
    expect(await unreadCount(h.db, "b")).toBe(1); // fremde ID ignoriert
    const events: LiveEvent[] = [];
    const off = subscribe("a", (e) => events.push(e));
    expect(await markRead(h.db, "a")).toBe(0);
    expect(events).toEqual([{ type: "read", unread: 0 }]);
    off();
  });

  it("gebündelt (Q5-03): je Person und Schlüssel eine Nachricht – ersetzt, wieder ungelesen, oben", async () => {
    await markRead(h.db, "a");
    const events: LiveEvent[] = [];
    const off = subscribe("a", (e) => events.push(e));
    const opts = { moduleId: "stundenplan", bundleKey: "stundenplan:2026-10-13" };
    await notifyBundled(h.db, [{ userId: "a", title: "Entfall Di 13.10., 3. Std: Mathe (7b)" }, { userId: "b", title: "B" }], opts);
    await markRead(h.db, "a");
    await notify(h.db, ["a"], { moduleId: "test", title: "Dazwischen" });
    await notifyBundled(h.db, [{ userId: "a", title: "Vertretungsplan Di 13.10.: 1 Änderung, 1 Entfall", body: "…" }], opts);
    const list = await listNotifications(h.db, "a");
    expect(list.map((n) => n.title)).toEqual(["Vertretungsplan Di 13.10.: 1 Änderung, 1 Entfall", "Dazwischen", "Zweite", "Hallo"]);
    expect(list[0]!.readAt).toBeNull();
    expect(await unreadCount(h.db, "a")).toBe(2);
    // dieselbe id kommt live erneut – der Client ersetzt den Eintrag
    const pushed = events.filter((e) => e.type === "notification").map((e) => (e as { notification: { id: string } }).notification.id);
    expect(pushed[0]).toBe(pushed[2]);
    // anderer Tag = eigene Nachricht; andere Person unberührt
    await notifyBundled(h.db, [{ userId: "a", title: "Mi" }], { ...opts, bundleKey: "stundenplan:2026-10-14" });
    expect((await listNotifications(h.db, "a")).length).toBe(5);
    expect((await listNotifications(h.db, "b")).map((n) => n.title)).toContain("B");
    expect(await notifyBundled(h.db, [], opts)).toBe(0);
    off();
  });
});
