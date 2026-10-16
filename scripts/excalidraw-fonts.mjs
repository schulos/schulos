// Schriften der Tafeln (P3-12) lokal ausliefern: kopiert die Excalidraw-Schriften aus node_modules nach
// public/excalidraw/fonts (eingecheckt wie die UI-Schriften, TD-04 – der Build lädt nichts aus dem Netz, das Image braucht
// keinen Kopierschritt). Excalidraw sucht sie unter window.EXCALIDRAW_ASSET_PATH + "fonts/…" (board-loader.tsx).
// Nicht kopiert: Xiaolai (CJK, ~13 MB) – für chinesische/japanische Zeichen fällt der Browser auf eine Systemschrift zurück.
// Aufruf nach einem Update von @excalidraw/excalidraw: node scripts/excalidraw-fonts.mjs  (Test: src/modules/tafeln/fonts.test.ts)
// Lizenztexte (OFL §2: Copyright + Lizenz bei jeder Kopie) liegen getrennt in public/excalidraw/lizenzen/ – bei einer neuen
// Familie dort ergänzen (das Paket selbst enthält keine; Copyright-Zeilen stehen in der name-Tabelle der Schriften).
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const SKIP = new Set(["Xiaolai"]);
const SOURCE = path.join("node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const TARGET = path.join("public", "excalidraw", "fonts");

if (!existsSync(SOURCE)) {
  console.error(`${SOURCE} fehlt – erst npm ci`);
  process.exit(1);
}
rmSync(TARGET, { recursive: true, force: true });
for (const family of readdirSync(SOURCE)) {
  if (SKIP.has(family)) continue;
  cpSync(path.join(SOURCE, family), path.join(TARGET, family), { recursive: true });
}
console.log(`Excalidraw-Schriften nach ${TARGET} kopiert (ohne ${[...SKIP].join(", ")}).`);
