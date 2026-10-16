import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { DbHandle } from "@/core/db/client";
import { auditLog, notifications } from "@/core/db/schema";
import { createSeededTestDb } from "@/core/db/testing";
import { ForbiddenError, loadPermissions, usersWithPermission } from "@/core/permissions";
import { ValidationError } from "@/modules/verwaltung/users";
import { dismissReport, hidePost, openReports, reportPost, setTopicLocked, unhidePost } from "./moderation";
import { createTopic, getTopic, reply, searchTopics } from "./service";

const NOW = new Date("2026-10-05T08:00:00Z");

describe("Foren-Moderation", () => {
  let h: DbHandle;
  let topic: string;
  let bad: string;
  const p = (id: string) => loadPermissions(h.db, id);
  const lastAudit = async (action: string) => (await h.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)).limit(1))[0];

  beforeAll(async () => {
    h = await createSeededTestDb();
    topic = await createTopic(h.db, await p("u-lea.schaefer"), "g-7b", { title: "Pausenhof", body: "Wer spielt Fußball?" }, NOW);
    bad = await reply(h.db, await p("u-lea.schaefer"), topic, "Unfreundlicher Satz über Quadratwurzel", new Date(NOW.getTime() + 60_000));
  }, 60_000);
  afterAll(() => h.close());

  it("Rechte-Inhaber:innen finden: Verwaltung per Rolle, Admin immer", async () => {
    const mods = await usersWithPermission(h.db, "foren.moderate");
    expect(mods).toEqual(expect.arrayContaining(["u-sabine.kowalski", "u-admin"]));
    expect(mods).not.toContain("u-jana.brandt");
  });

  it("melden: einmal je Person, Gong an Leitung und Moderation, erscheint in der Liste der Klassenleitung", async () => {
    const jana = await p("u-jana.brandt");
    expect((await getTopic(h.db, jana, topic))!.canModerate).toBe(true);
    await expect(reportPost(h.db, await p("u-daniel.okafor"), bad, "Beleidigend", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reportPost(h.db, jana, bad, "x", NOW)).rejects.toBeInstanceOf(ValidationError);
    await reportPost(h.db, jana, bad, "Beleidigend", NOW);
    await expect(reportPost(h.db, jana, bad, "Beleidigend", NOW)).rejects.toBeInstanceOf(ValidationError);
    const gongs = await h.db.select().from(notifications).where(and(eq(notifications.moduleId, "foren"), eq(notifications.userId, "u-sabine.kowalski")));
    expect(gongs.map((g) => g.title)).toContain("Gemeldeter Beitrag: Pausenhof");
    // die Meldende selbst bekommt keinen Gong, obwohl sie Leitung ist
    expect(await h.db.select().from(notifications).where(and(eq(notifications.moduleId, "foren"), eq(notifications.userId, "u-jana.brandt"), eq(notifications.title, "Gemeldeter Beitrag: Pausenhof")))).toEqual([]);

    expect((await openReports(h.db, await p("u-jana.brandt"))).map((r) => r.postId)).toEqual([bad]);
    expect(await openReports(h.db, await p("u-lea.schaefer"))).toEqual([]);
    expect((await openReports(h.db, await p("u-sabine.kowalski"))).map((r) => [r.postId, r.forumName])).toEqual([[bad, "Klasse 7b"]]);
  });

  it("ausblenden mit Grund: Text nur für die Moderation, Meldungen erledigt, Protokoll, Suche findet ihn nicht", async () => {
    const lea = await p("u-lea.schaefer");
    expect((await searchTopics(h.db, lea, "Quadratwurzel")).map((t) => t.id)).toEqual([topic]);
    await expect(hidePost(h.db, lea, bad, "weg damit", NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(hidePost(h.db, await p("u-jana.brandt"), bad, "", NOW)).rejects.toBeInstanceOf(ValidationError);
    await hidePost(h.db, await p("u-jana.brandt"), bad, "Umgangston", NOW);

    const asLea = (await getTopic(h.db, lea, topic))!.posts.find((x) => x.id === bad)!;
    expect(asLea).toMatchObject({ body: null, hiddenReason: "Umgangston" });
    const asJana = (await getTopic(h.db, await p("u-jana.brandt"), topic))!.posts.find((x) => x.id === bad)!;
    expect(asJana.body).toContain("Quadratwurzel");
    expect(await openReports(h.db, await p("u-jana.brandt"))).toEqual([]);
    expect(await lastAudit("foren.hide")).toMatchObject({ actorId: "u-jana.brandt", target: bad, meta: { reason: "Umgangston" } });
    expect(await searchTopics(h.db, lea, "Quadratwurzel")).toEqual([]);

    await unhidePost(h.db, await p("u-sabine.kowalski"), bad);
    expect((await getTopic(h.db, lea, topic))!.posts.find((x) => x.id === bad)!.body).toContain("Quadratwurzel");
  });

  it("Thema sperren: keine Antworten mehr; Verwaltung moderiert auch ohne Mitgliedschaft; verwerfen", async () => {
    await expect(setTopicLocked(h.db, await p("u-lea.schaefer"), topic, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setTopicLocked(h.db, await p("u-sabine.kowalski"), topic, true);
    await expect(reply(h.db, await p("u-lea.schaefer"), topic, "Noch was")).rejects.toBeInstanceOf(ValidationError);
    expect(await lastAudit("foren.lock")).toMatchObject({ actorId: "u-sabine.kowalski", target: topic });
    await setTopicLocked(h.db, await p("u-jana.brandt"), topic, false);

    const first = (await getTopic(h.db, await p("u-jana.brandt"), topic))!.posts[0]!;
    await reportPost(h.db, await p("u-jana.brandt"), first.id, "Bitte prüfen", NOW);
    const [rep] = await openReports(h.db, await p("u-sabine.kowalski"));
    await expect(dismissReport(h.db, await p("u-lea.schaefer"), rep!.id)).rejects.toBeInstanceOf(ForbiddenError);
    await dismissReport(h.db, await p("u-sabine.kowalski"), rep!.id);
    expect(await openReports(h.db, await p("u-sabine.kowalski"))).toEqual([]);
    expect((await getTopic(h.db, await p("u-lea.schaefer"), topic))!.posts[0]!.body).toBe("Wer spielt Fußball?");
  });
});
