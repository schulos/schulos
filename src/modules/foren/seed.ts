import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { forumPosts, forumSubscriptions, forumTopics, groupFeatures, groups } from "@/core/db/schema";
import { FORUM_FEATURE } from "./service";

/** Foren für Klassen, Kurse und AGs + je ein Beispielthema in der 7b und im Kollegium. */
export async function seedForen(db: Db, now = new Date()) {
  const gs = await db.select({ id: groups.id }).from(groups).where(inArray(groups.kind, ["klasse", "kurs", "ag"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: FORUM_FEATURE })));
  const h = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  await db.insert(forumTopics).values([
    { id: "topic-7b-lektuere", groupId: "g-7b", authorId: "u-jana.brandt", title: "Fragen zur Lektüre", createdAt: h(48), lastPostAt: h(20) },
    { id: "topic-kollegium-wandertag", groupId: null, authorId: "u-petra.lindner", title: "Wandertag im Frühjahr – Ideen", createdAt: h(72), lastPostAt: h(30) },
  ]);
  await db.insert(forumPosts).values([
    { topicId: "topic-7b-lektuere", authorId: "u-jana.brandt", body: "Hier könnt ihr Fragen zum **Lesetagebuch** stellen.", createdAt: h(48) },
    { topicId: "topic-7b-lektuere", authorId: "u-lea.schaefer", body: "Müssen wir die Kapitel 4 und 5 schon bis Montag lesen?", createdAt: h(20) },
    { topicId: "topic-kollegium-wandertag", authorId: "u-petra.lindner", body: "Bitte bis Ende des Monats Ziele vorschlagen.", createdAt: h(72) },
    { topicId: "topic-kollegium-wandertag", authorId: "u-jana.brandt", body: "Die 7b würde gern in den Kletterwald.", createdAt: h(30) },
  ]);
  await db.insert(forumSubscriptions).values([
    { topicId: "topic-7b-lektuere", userId: "u-jana.brandt" },
    { topicId: "topic-7b-lektuere", userId: "u-lea.schaefer" },
    { topicId: "topic-kollegium-wandertag", userId: "u-petra.lindner" },
    { topicId: "topic-kollegium-wandertag", userId: "u-jana.brandt" },
  ]);
}
