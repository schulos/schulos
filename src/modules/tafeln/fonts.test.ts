import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// P3-12: Excalidraw lädt seine Schriften von window.EXCALIDRAW_ASSET_PATH, sonst aus einem CDN (das die CSP sperrt). Die
// eingecheckten Kopien unter public/excalidraw/fonts müssen zur installierten Version passen (Dateinamen tragen Hashes) –
// nach einem Update von @excalidraw/excalidraw: node scripts/excalidraw-fonts.mjs
const SOURCE = path.join("node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const TARGET = path.join("public", "excalidraw", "fonts");

function files(root: string, skip: Set<string> = new Set()): Map<string, number> {
  const out = new Map<string, number>();
  for (const family of readdirSync(root)) {
    if (skip.has(family)) continue;
    for (const f of readdirSync(path.join(root, family))) out.set(`${family}/${f}`, statSync(path.join(root, family, f)).size);
  }
  return out;
}

describe("Tafeln – lokale Schriften", () => {
  it("public/excalidraw/fonts entspricht den Schriften des installierten Pakets (ohne Xiaolai)", () => {
    const want = files(SOURCE, new Set(["Xiaolai"]));
    const have = files(TARGET);
    expect(want.size).toBeGreaterThan(10);
    expect([...have.keys()].sort(), "node scripts/excalidraw-fonts.mjs ausführen").toEqual([...want.keys()].sort());
    for (const [f, size] of want) expect(have.get(f), f).toBe(size);
  });

  it("jede ausgelieferte Schriftfamilie hat Copyright-Hinweis und Lizenztext dabei (P312-10, OFL §2)", () => {
    const LICENSES: Record<string, { file: string; license: RegExp }> = {
      Assistant: { file: "Assistant.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      Cascadia: { file: "Cascadia-Code.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      ComicShanns: { file: "Comic-Shanns.txt", license: /MIT License[\s\S]*Permission is hereby granted/ },
      Excalifont: { file: "Excalifont.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      Liberation: { file: "Liberation-Sans.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      Lilita: { file: "Lilita-One.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      Nunito: { file: "Nunito.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
      Virgil: { file: "Virgil.txt", license: /SIL OPEN FONT LICENSE Version 1\.1/ },
    };
    const families = readdirSync(TARGET).sort();
    expect(families, "neue Schriftfamilie → Lizenzdatei unter public/excalidraw/lizenzen anlegen").toEqual(Object.keys(LICENSES).sort());
    for (const family of families) {
      const text = readFileSync(path.join("public", "excalidraw", "lizenzen", LICENSES[family]!.file), "utf8");
      expect(text, family).toMatch(/Copyright|©/);
      expect(text, family).toMatch(LICENSES[family]!.license);
      expect(text, family).toContain(`fonts/${family}/`);
    }
    expect(readFileSync(path.join("public", "excalidraw", "LIZENZEN.txt"), "utf8")).toContain("lizenzen/");
  });

  it("Excalidraw sucht die Schriften unter <ASSET_PATH>/fonts/<Familie>/<Datei>", () => {
    // Pfadschema im Paket – ändert es sich, stimmt der Asset-Pfad in board-loader.tsx nicht mehr
    const pkg = readFileSync(path.join("node_modules", "@excalidraw", "excalidraw", "dist", "prod", "index.js"), "utf8");
    const chunks = readdirSync(path.join("node_modules", "@excalidraw", "excalidraw", "dist", "prod")).filter((f) => f.endsWith(".js"));
    const all = pkg + chunks.map((c) => readFileSync(path.join("node_modules", "@excalidraw", "excalidraw", "dist", "prod", c), "utf8")).join("\n");
    expect(all).toContain("EXCALIDRAW_ASSET_PATH");
    expect(all).toMatch(/fonts\/Excalifont\/Excalifont-Regular-[0-9a-f]+\.woff2/);
  });
});
