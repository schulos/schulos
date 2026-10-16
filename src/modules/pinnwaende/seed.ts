import { inArray } from "drizzle-orm";
import type { Db } from "@/core/db/client";
import { boardCards, boardColumns, boards, groupFeatures, groups } from "@/core/db/schema";
import { BOARD_FEATURE } from "./service";

/** Pinnwände für Klassen, Kurse und AGs + eine Beispiel-Pinnwand in der 7b. */
export async function seedPinnwaende(db: Db) {
  const gs = await db.select({ id: groups.id }).from(groups).where(inArray(groups.kind, ["klasse", "kurs", "ag"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: BOARD_FEATURE })));
  await db.insert(boards).values({ id: "board-7b-projekt", groupId: "g-7b", ownerId: "u-jana.brandt", title: "Projekt Klimaschutz", mode: "alle" });
  await db.insert(boardColumns).values([
    { id: "col-7b-ideen", boardId: "board-7b-projekt", title: "Ideen", position: 0 },
    { id: "col-7b-quellen", boardId: "board-7b-projekt", title: "Quellen", position: 1 },
  ]);
  await db.insert(boardCards).values([
    { boardId: "board-7b-projekt", columnId: "col-7b-ideen", authorId: "u-jana.brandt", kind: "text", title: "Energie sparen in der Schule", body: "Wo verbrauchen wir am meisten?", position: 0 },
    { boardId: "board-7b-projekt", columnId: "col-7b-quellen", authorId: "u-jana.brandt", kind: "link", title: "Umweltbundesamt", url: "https://www.umweltbundesamt.de/", position: 0 },
  ]);
}
