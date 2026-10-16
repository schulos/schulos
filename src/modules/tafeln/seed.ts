import type { Db } from "@/core/db/client";
import { fileNodes } from "@/core/db/schema";
import { newStorageKey, type FileStorage } from "@/core/files/storage";
import { serializeScene, type BoardElement } from "./scene";
import { BOARD_MIME } from "./service";

export const DEMO_BOARD_ID = "tafel-7b-brueche";

const base = { angle: 0, strokeColor: "#1e1e1e", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, boundElements: null, link: null, locked: false, isDeleted: false, updated: 1760000000000 };

const text = (id: string, index: string, x: number, y: number, t: string, fontSize = 28): BoardElement => ({
  ...base,
  id,
  type: "text",
  index,
  x,
  y,
  width: t.length * fontSize * 0.55,
  height: fontSize * 1.25,
  backgroundColor: "transparent",
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  text: t,
  originalText: t,
  fontSize,
  fontFamily: 5,
  textAlign: "left",
  verticalAlign: "top",
  containerId: null,
  autoResize: true,
  lineHeight: 1.25,
});

/** Beispieltafel „Brüche“ im Gruppenordner der 7b (nur mit Dateispeicher). */
export async function seedTafeln(db: Db, storage: FileStorage) {
  const elements: BoardElement[] = [
    text("demo-titel", "a0", 40, 30, "Brüche – Tafelbild"),
    { ...base, id: "demo-ganzes", type: "rectangle", index: "a1", x: 40, y: 100, width: 320, height: 80, backgroundColor: "#a5d8ff", roundness: null, seed: 2, version: 1, versionNonce: 2 },
    { ...base, id: "demo-viertel", type: "rectangle", index: "a2", x: 40, y: 200, width: 80, height: 80, backgroundColor: "#ffc9c9", roundness: null, seed: 3, version: 1, versionNonce: 3 },
    text("demo-bruch", "a3", 140, 220, "= 1/4 vom Ganzen", 24),
  ];
  const data = new TextEncoder().encode(serializeScene(elements));
  const storageKey = newStorageKey();
  await storage.put(storageKey, data);
  await db.insert(fileNodes).values({ id: DEMO_BOARD_ID, kind: "file", name: "Brüche.excalidraw", groupId: "g-7b", size: data.byteLength, mime: BOARD_MIME, storageKey, createdBy: "u-jana.brandt" });
}
