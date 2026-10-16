import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { forumTopics, notifications } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions } from "@/core/permissions";
import { setGroupFeature } from "@/modules/verwaltung/groups";
import { ValidationError } from "@/modules/verwaltung/users";
import { setTopicLocked } from "./moderation";
import { createTopic, editPost, getTopic, KOLLEGIUM, listForums, listTopics, reply, searchTopics, setSubscription } from "./service";

const NOW = new Date("2026-10-05T08:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

describe("Foren", () => {
  let h: DbHandle;
  const p = (id: string) => loadPermissions(h.db, id);
  const gongs = (uid: string) => h.db.select().from(notifications).where(and(eq(notifications.userId, uid), eq(notifications.moduleId, "foren")));

  beforeAll(async () => {
    h = await createSeededTestDb();
  }, 60_000);
  afterAll(() => h.close());

  it("Foren je Gruppe mit Merkmal; Kollegium nur fürs Personal", async () => {
    const lea = (await listForums(h.db, await p("u-lea.schaefer"))).map((f) => f.key);
    expect(lea).toContain("g-7b");
    expect(lea).not.toContain(KOLLEGIUM);
    const jana = await listForums(h.db, await p("u-jana.brandt"));
    expect(jana[0]).toMatchObject({ key: KOLLEGIUM, name: "Kollegium", topics: 1 });
    expect(jana.find((f) => f.key === "g-7b")?.topics).toBe(1);
    await expect(listTopics(h.db, await p("u-lea.schaefer"), KOLLEGIUM)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listTopics(h.db, await p("u-lea.schaefer"), "g-q1-e-gk1")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Thema anlegen, antworten: Abo für Autor:innen, Gong an andere Abonnent:innen, gesperrtes Thema nimmt nichts an", async () => {
    const lea = await p("u-lea.schaefer");
    const id = await createTopic(h.db, lea, "g-7b", { title: "  Hausaufgabe Mathe  ", body: "Wer hat Aufgabe 3?" }, NOW);
    expect((await listTopics(h.db, lea, "g-7b")).find((t) => t.id === id)).toMatchObject({ id, title: "Hausaufgabe Mathe", posts: 1, authorName: "Lea Schäfer" });

    const jana = await p("u-jana.brandt");
    await reply(h.db, jana, id, "Schaut in Kapitel 2.", later(5));
    expect((await gongs("u-lea.schaefer")).map((g) => g.title)).toEqual(["Neue Antwort: Hausaufgabe Mathe"]);
    expect(await gongs("u-jana.brandt")).toEqual([]);
    const topic = (await getTopic(h.db, jana, id))!;
    expect(topic.subscribed).toBe(true);
    expect(topic.posts.map((x) => [x.authorName, x.mine])).toEqual([
      ["Lea Schäfer", false],
      ["Jana Brandt", true],
    ]);
    expect((await listTopics(h.db, lea, "g-7b")).find((t) => t.id === id)!.lastPostAt).toEqual(later(5));

    // Abo abbestellen → kein Gong mehr
    await setSubscription(h.db, lea, id, false);
    await reply(h.db, jana, id, "Und Aufgabe 4 auch.", later(6));
    expect((await gongs("u-lea.schaefer")).length).toBe(1);

    await h.db.update(forumTopics).set({ locked: true }).where(eq(forumTopics.id, id));
    await expect(reply(h.db, lea, id, "Noch was", later(7))).rejects.toBeInstanceOf(ValidationError);
    await expect(createTopic(h.db, lea, "g-7b", { title: "", body: "" }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("nur eigene Beiträge bearbeiten; Fremde lesen nicht", async () => {
    const jana = await p("u-jana.brandt");
    const topic = (await getTopic(h.db, jana, "topic-7b-lektuere"))!;
    const leasPost = topic.posts.find((x) => x.authorName === "Lea Schäfer")!;
    await expect(editPost(h.db, jana, leasPost.id, "geändert")).rejects.toBeInstanceOf(ForbiddenError);
    await editPost(h.db, await p("u-lea.schaefer"), leasPost.id, "Kapitel 4 und 5 bis Montag?", later(1));
    expect((await getTopic(h.db, jana, "topic-7b-lektuere"))!.posts.find((x) => x.id === leasPost.id)).toMatchObject({ body: "Kapitel 4 und 5 bis Montag?", editedAt: later(1) });
    expect(await getTopic(h.db, await p("u-daniel.okafor"), "topic-7b-lektuere")).toBeNull();
  });

  it("Review 2026-10-10: Moderation liest jedes Forum, schreibt aber nur als Mitglied; gesperrte Themen bleiben eingefroren", async () => {
    const sabine = await p("u-sabine.kowalski");
    const lea = await p("u-lea.schaefer");
    expect(await getTopic(h.db, sabine, "topic-7b-lektuere")).toMatchObject({ canWrite: false, canModerate: true });
    await expect(createTopic(h.db, sabine, "g-7b", { title: "Hallo", body: "von außen" }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reply(h.db, sabine, "topic-7b-lektuere", "von außen", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSubscription(h.db, sabine, "topic-7b-lektuere", true)).rejects.toBeInstanceOf(ForbiddenError);

    const topic = await createTopic(h.db, lea, "g-7b", { title: "Streit", body: "Erster Beitrag" }, NOW);
    const [post] = (await getTopic(h.db, lea, topic))!.posts;
    await setTopicLocked(h.db, sabine, topic, true);
    await expect(editPost(h.db, lea, post!.id, "nachträglich geändert")).rejects.toBeInstanceOf(ValidationError);
  });

  it("Merkmal aus → Forum weg; Suche findet Stammformen nur in eigenen Foren", async () => {
    const lea = await p("u-lea.schaefer");
    expect((await searchTopics(h.db, lea, "Kapiteln")).map((r) => r.id)).toContain("topic-7b-lektuere");
    expect((await searchTopics(h.db, lea, "Kletterwald")).map((r) => r.id)).toEqual([]);
    expect((await searchTopics(h.db, await p("u-jana.brandt"), "Kletterwald"))[0]).toMatchObject({ id: "topic-kollegium-wandertag", forumName: "Kollegium" });

    await setGroupFeature(h.db, "u-admin", "g-7b", "foren.forum", false);
    expect((await listForums(h.db, lea)).map((f) => f.key)).not.toContain("g-7b");
    expect(await getTopic(h.db, lea, "topic-7b-lektuere")).toBeNull();
    await setGroupFeature(h.db, "u-admin", "g-7b", "foren.forum", true);
  });
});
