import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { chatMessages, chatReads, chatRooms, groupFeatures, groups } from "@/core/db/schema";
import { GROUP_ROOM_FEATURE } from "./service";

/** Gruppenchats für feste Gruppen + ein lebendiger Klassenteam-Verlauf für die Demo. */
export async function seedMessenger(db: Db, now = new Date()) {
  const gs = await db.select({ id: groups.id }).from(groups).where(inArray(groups.kind, ["klasse", "kurs", "ag", "fachschaft", "gremium"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: GROUP_ROOM_FEATURE })));
  await db.insert(chatRooms).values(gs.map((g) => ({ id: `room-${g.id}`, kind: "group" as const, groupId: g.id })));

  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const msgs = [
    { roomId: "room-g-lehrerkonferenz", authorId: "u-petra.lindner", body: "Erinnerung: Konferenz am Dienstag in der Aula.", createdAt: min(600) },
    { roomId: "room-g-7b", authorId: "u-jana.brandt", body: "Denkt an die Einverständniserklärung für den Wandertag!", createdAt: min(180) },
    { roomId: "room-g-ag-schuelerzeitung", authorId: "u-jana.brandt", body: "Wer schreibt den Artikel über das Sportfest?", createdAt: min(95) },
    { roomId: "room-g-ag-schuelerzeitung", authorId: "u-lea.schaefer", body: "Ich! Fotos hab ich auch schon.", createdAt: min(90) },
  ];
  await db.insert(chatMessages).values(msgs);
  for (const roomId of new Set(msgs.map((m) => m.roomId))) {
    const last = msgs.filter((m) => m.roomId === roomId).at(-1)!.createdAt;
    await db.update(chatRooms).set({ lastMessageAt: last }).where(inArray(chatRooms.id, [roomId]));
  }
  // Lea hat den Schülerzeitungs-Chat gelesen (ihre eigene Nachricht)
  await db.insert(chatReads).values({ roomId: "room-g-ag-schuelerzeitung", userId: "u-lea.schaefer", lastReadAt: min(90) });
}
