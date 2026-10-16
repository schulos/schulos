// DS-13: schreibt die Kurzfassungen der DSB-Checkliste (src/core/privacy/checkliste.ts) in docs/DSB-FRAGEN.md.
// Aufruf: npx tsx scripts/dsb-checkliste.ts   (checkliste.test.ts prüft, dass die Datei aktuell ist)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderChecklistDoc } from "../src/core/privacy/checkliste";
import { MODULES } from "../src/modules";

const file = path.join(process.cwd(), "docs", "DSB-FRAGEN.md");
const before = readFileSync(file, "utf8");
const after = renderChecklistDoc(
  before,
  MODULES.flatMap((m) => m.settings ?? []),
);
if (after !== before.replace(/\r\n/g, "\n")) {
  writeFileSync(file, after);
  console.log("docs/DSB-FRAGEN.md aktualisiert");
} else console.log("docs/DSB-FRAGEN.md ist aktuell");
