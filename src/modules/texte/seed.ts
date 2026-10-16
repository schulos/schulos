import { inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "@/core/db/client";
import { groupFeatures, groups, textDocs } from "@/core/db/schema";
import { toBase64 } from "./live";
import { appendBlocks } from "./markdown";
import { TEXT_FEATURE } from "./service";

/** Texte für Klassen, Kurse und AGs + ein Beispieltext in der 7b (Klassenregeln). */
export async function seedTexte(db: Db) {
  const gs = await db.select({ id: groups.id }).from(groups).where(inArray(groups.kind, ["klasse", "kurs", "ag"]));
  await db.insert(groupFeatures).values(gs.map((g) => ({ groupId: g.id, feature: TEXT_FEATURE })));
  const doc = new Y.Doc();
  appendBlocks(doc, [
    { type: "heading", level: 1, runs: ["Unsere Klassenregeln"] },
    { type: "paragraph", runs: ["Gemeinsam erarbeitet im ", { text: "Klassenrat", bold: true }, " – wir ergänzen die Liste, wenn uns etwas fehlt."] },
    { type: "bulletList", items: [["Wir lassen einander ausreden."], ["Handys bleiben im Unterricht in der Tasche."], ["Wer etwas ausleiht, gibt es heil zurück."]] },
    { type: "paragraph", runs: [{ text: "Offen:", italic: true }, " Regel für den Pausenhof"] },
  ]);
  await db.insert(textDocs).values({
    id: "text-7b-regeln",
    groupId: "g-7b",
    ownerId: "u-jana.brandt",
    title: "Klassenregeln",
    mode: "alle",
    state: toBase64(Y.encodeStateAsUpdate(doc)),
    version: 1,
  });
  doc.destroy();
}
