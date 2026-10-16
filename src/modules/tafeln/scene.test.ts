import { describe, expect, it } from "vitest";
import { boardFileName, boardTitle, elementId, isBoardName, MAX_VERSION, mergeElements, orderElements, parseScene, pruneTombstones, safeLink, sanitizeElement, serializeScene, tombstone, wins, type BoardElement } from "./scene";

const el = (id: string, version: number, extra: Partial<BoardElement> = {}): BoardElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  isDeleted: false,
  index: "a0",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
});

describe("Tafeln – Szene und Abgleich je Element", () => {
  it("höhere Version gewinnt, bei Gleichstand die kleinere Nonce – unabhängig von der Reihenfolge", () => {
    expect(wins(el("a", 2), el("a", 1))).toBe(true);
    expect(wins(el("a", 1), el("a", 2))).toBe(false);
    expect(wins(el("a", 3, { versionNonce: 5 }), el("a", 3, { versionNonce: 9 }))).toBe(true);
    expect(wins(el("a", 3, { versionNonce: 9 }), el("a", 3, { versionNonce: 5 }))).toBe(false);
    expect(wins(el("a", 3), el("a", 3))).toBe(false); // gleich → nichts zu tun
    expect(wins(el("a", 1), undefined)).toBe(true);

    // drei Fassungen, alle Reihenfolgen → derselbe Stand
    const fs = [el("x", 4, { versionNonce: 7, width: 1 }), el("x", 4, { versionNonce: 3, width: 2 }), el("x", 2, { width: 3 })];
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
    for (const o of orders) {
      const m = new Map<string, BoardElement>();
      for (const i of o) mergeElements(m, [fs[i]!]);
      expect(m.get("x")!.width).toBe(2);
    }
  });

  it("merge liefert nur Übernommenes; unbekannte Grabsteine legen nichts an, bekannte löschen", () => {
    const m = new Map<string, BoardElement>([["a", el("a", 2)]]);
    expect(mergeElements(m, [el("a", 1), el("b", 1, { isDeleted: true })])).toEqual([]);
    expect(m.has("b")).toBe(false);
    const changed = mergeElements(m, [el("a", 3, { isDeleted: true }), el("c", 1)]);
    expect(changed.map((e) => e.id)).toEqual(["a", "c"]);
    expect(m.get("a")!.isDeleted).toBe(true);
    // verspätete ältere Fassung belebt den Grabstein nicht wieder
    expect(mergeElements(m, [el("a", 2)])).toEqual([]);
  });

  it("Grabsteine fallen nach einem Tag weg, frische bleiben", () => {
    const now = Date.UTC(2026, 9, 12);
    const m = new Map<string, BoardElement>([
      ["alt", el("alt", 2, { isDeleted: true, updated: now - 25 * 3600_000 })],
      ["neu", el("neu", 2, { isDeleted: true, updated: now - 3600_000 })],
      ["lebt", el("lebt", 2, { updated: now - 48 * 3600_000 })],
      ["ohne", el("ohne", 2, { isDeleted: true })],
    ]);
    expect(pruneTombstones(m, now)).toBe(1);
    expect([...m.keys()].sort()).toEqual(["lebt", "neu", "ohne"]);
  });

  it("Reihenfolge nach Fractional Index (Codepunkte), ohne Index ans Ende", () => {
    const sorted = orderElements([el("c", 1, { index: "a1" }), el("n", 1, { index: null }), el("a", 1, { index: "Zz" }), el("b", 1, { index: "a0V" })]);
    expect(sorted.map((e) => e.id)).toEqual(["a", "b", "c", "n"]);
  });

  it("Elemente prüfen: Art, Version, Koordinaten, Verweise, keine Bilder/eingebetteten Seiten", () => {
    expect(sanitizeElement(el("ok", 1))).toMatchObject({ id: "ok" });
    expect(sanitizeElement({ ...el("x", 1), index: undefined })?.index).toBeNull();
    for (const bad of [
      null,
      [],
      "x",
      { ...el("x", 1), type: "image" },
      { ...el("x", 1), type: "embeddable" },
      { ...el("x", 1), type: "iframe" },
      { ...el("x", 1), version: 0 },
      { ...el("x", 1), version: 1.5 },
      { ...el("x", 1), versionNonce: "1" },
      { ...el("x", 1), isDeleted: "nein" },
      { ...el("x", 1), id: "../böse" },
      { ...el("x", 1), id: "a".repeat(65) },
      { ...el("x", 1), index: "a 0" },
      { ...el("x", 1), x: 1e9 },
      { ...el("x", 1), width: "10" },
      { ...el("x", 1), type: "freedraw", points: [[0, 0], [1]] },
      { ...el("x", 1), type: "line", points: "0,0" },
      { ...el("x", 1), type: "rectangle", fileId: "abc" },
    ]) {
      expect(sanitizeElement(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(sanitizeElement({ ...el("x", 1), link: "javascript:alert(1)" })?.link).toBeNull();
    expect(sanitizeElement({ ...el("x", 1), link: "//fremd.example/x" })?.link).toBeNull();
    expect(sanitizeElement({ ...el("x", 1), link: "https://example.org/a" })?.link).toBe("https://example.org/a");
    expect(sanitizeElement({ ...el("x", 1), link: "/texte/abc" })?.link).toBe("/texte/abc");
    expect(safeLink(" HTTP://x.de ")).toBe("HTTP://x.de");
  });

  it("Grabsteine tragen keinen Inhalt mehr (P312-03), aber genug, dass Excalidraw sie annimmt", () => {
    const text = el("t", 3, { type: "text", text: "Geheimer Text", originalText: "Geheimer Text", link: "https://x.de", isDeleted: true, updated: 5, customData: { a: 1 } });
    const t = sanitizeElement(text)!;
    expect(t).toEqual({ id: "t", type: "text", version: 3, versionNonce: 100, isDeleted: true, index: "a0", x: 0, y: 0, width: 1, height: 1, angle: 0, updated: 5 });
    expect(JSON.stringify(t)).not.toContain("Geheim");
    // Linien/Freihand: zwei Punkte, sonst verwirft restoreElements den Grabstein und die Löschung käme nicht an
    expect(sanitizeElement(el("f", 2, { type: "freedraw", points: [[0, 0], [5, 5], [9, 9]], pressures: [1, 1, 1], isDeleted: true }))).toMatchObject({ points: [[0, 0], [1, 1]] });
    expect(sanitizeElement(el("f", 2, { type: "freedraw", isDeleted: true }))!.pressures).toBeUndefined();
    // Art und Version werden weiter geprüft
    expect(sanitizeElement({ ...el("i", 2, { isDeleted: true }), type: "image" })).toBeNull();
    expect(sanitizeElement({ ...el("i", 0, { isDeleted: true }) })).toBeNull();

    // ältere Datei mit vollen Grabsteinen: beim Lesen ausgedünnt und gezählt
    const old = JSON.stringify({ type: "excalidraw", elements: [text, el("a", 1), tombstone(el("b", 2))] });
    const s = parseScene(old)!;
    expect(s.thinned).toBe(1);
    expect(JSON.stringify(s.elements)).not.toContain("Geheim");
  });

  it("Datei lesen und schreiben (Excalidraw-Format); Kaputtes wird verworfen", () => {
    const text = serializeScene([el("b", 1, { index: "a1" }), el("a", 1, { index: "a0" })], "#f8f9fa");
    const data = JSON.parse(text) as { type: string; version: number; elements: BoardElement[]; files: object };
    expect(data).toMatchObject({ type: "excalidraw", version: 2, files: {} });
    expect(data.elements.map((e) => e.id)).toEqual(["a", "b"]);
    expect(parseScene(text)).toMatchObject({ background: "#f8f9fa", dropped: 0 });

    const mixed = JSON.stringify({ type: "excalidraw", elements: [el("a", 1), { type: "image", id: "i" }, el("a", 2, { width: 99 })], appState: { viewBackgroundColor: "url(x)" } });
    const s = parseScene(mixed)!;
    expect(s.dropped).toBe(1);
    expect(s.elements).toHaveLength(1);
    expect(s.elements[0]!.width).toBe(99);
    expect(s.background).toBe("#ffffff");

    expect(parseScene("")).toEqual({ elements: [], background: "#ffffff", dropped: 0, thinned: 0 });
    expect(parseScene("kein json")).toBeNull();
    expect(parseScene("[]")).toBeNull();
    expect(parseScene(JSON.stringify({ type: "excalidrawlib", elements: [] }))).toBeNull();
    expect(parseScene(JSON.stringify({ elements: "x" }))).toBeNull();
  });

  it("G3B-01: nur bekannte Felder mit passendem Typ – was restoreElements zum Absturz brächte, fällt weg", () => {
    // die beiden Beispiele aus dem Review: Excalidraw wirft bei boundElementIds: 1 (map) bzw. font: 1 (split)
    const rect = sanitizeElement({ ...el("r", 1), boundElementIds: 1, strokeSharpness: "round", customData: { x: 1 }, __proto__x: 1 })!;
    expect(rect).not.toBeNull();
    expect(Object.keys(rect)).not.toContain("boundElementIds");
    expect(Object.keys(rect)).not.toContain("strokeSharpness");
    expect(Object.keys(rect)).not.toContain("customData");
    const text = sanitizeElement(el("t", 1, { type: "text", text: "Hallo", font: 1, fontSize: 20, fontFamily: 5 }))!;
    expect(text).toMatchObject({ text: "Hallo", fontSize: 20, fontFamily: 5 });
    expect(Object.keys(text)).not.toContain("font");

    // falscher Typ in einem bekannten Feld: Feld weg (Excalidraw setzt die Vorgabe), Element bleibt
    const typed = sanitizeElement(
      el("x", 1, {
        strokeColor: 1,
        backgroundColor: "url(javascript:x)",
        fillStyle: "plaid",
        strokeWidth: "2",
        opacity: 500,
        groupIds: ["g1", 2],
        boundElements: [{ id: "a", type: "arrow" }, { id: "b" }],
        roundness: { type: "x" },
        frameId: 7,
        locked: "ja",
        seed: 1.5,
      }),
    )!;
    for (const k of ["strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "opacity", "groupIds", "boundElements", "roundness", "frameId", "locked", "seed"]) {
      expect(Object.keys(typed), k).not.toContain(k);
    }
    expect(sanitizeElement(el("t", 1, { type: "text", text: 5, originalText: ["x"], textAlign: "justify", containerId: {} }))).toEqual(el("t", 1, { type: "text" }));

    // gültige Felder bleiben, verschachtelte Objekte werden neu aufgebaut (ohne Zusatzfelder)
    const good = {
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "dashed",
      roughness: 1,
      opacity: 100,
      seed: 12345,
      groupIds: ["g1"],
      frameId: null,
      roundness: { type: 3, extra: "weg" },
      boundElements: [{ id: "a1", type: "arrow", extra: 1 }],
      locked: false,
      updated: 5,
      link: null,
    };
    expect(sanitizeElement(el("g", 1, good))).toEqual(el("g", 1, { ...good, roundness: { type: 3 }, boundElements: [{ id: "a1", type: "arrow" }] }));
    const arrow = sanitizeElement(
      el("a", 1, {
        type: "arrow",
        points: [[0, 0], [10, 5]],
        lastCommittedPoint: null,
        startBinding: { elementId: "g", focus: 0.1, gap: 4, fixedPoint: [0.5, 1], extra: "weg" },
        endBinding: { elementId: 5, focus: 0, gap: 0 },
        startArrowhead: null,
        endArrowhead: "triangle",
        elbowed: false,
      }),
    )!;
    expect(arrow).toMatchObject({ startBinding: { elementId: "g", focus: 0.1, gap: 4, fixedPoint: [0.5, 1] }, endArrowhead: "triangle", elbowed: false });
    expect(arrow.startBinding).not.toHaveProperty("extra");
    expect(arrow).not.toHaveProperty("endBinding");
    // Freihand ohne (bzw. mit kaputten) Druckwerten: leer statt fehlend – Excalidraw liest pressures[i]
    expect(sanitizeElement(el("f", 1, { type: "freedraw", points: [[0, 0], [1, 1]], pressures: "x" }))!.pressures).toEqual([]);
    expect(sanitizeElement(el("f", 1, { type: "freedraw", points: [[0, 0], [1, 1]], pressures: [0.5, 0.7], simulatePressure: false }))).toMatchObject({ pressures: [0.5, 0.7], simulatePressure: false });
    // Felder anderer Elementarten werden nicht übernommen
    expect(sanitizeElement(el("r2", 1, { text: "versteckt", points: [[0, 0]], pressures: [1] }))).toEqual(el("r2", 1));

    // dasselbe beim Öffnen einer hochgeladenen .excalidraw-Datei
    const file = JSON.stringify({ type: "excalidraw", elements: [{ ...el("r", 1), boundElementIds: 1 }, el("t", 1, { type: "text", text: "Hi", font: 1 })] });
    const s = parseScene(file)!;
    expect(s.dropped).toBe(0);
    expect(JSON.stringify(s.elements)).not.toMatch(/boundElementIds|"font"/);
  });

  it("G3B-02: Version und Nonce haben eine Obergrenze", () => {
    expect(sanitizeElement(el("v", MAX_VERSION))).not.toBeNull();
    expect(sanitizeElement(el("v", MAX_VERSION + 1))).toBeNull();
    expect(sanitizeElement(el("v", Number.MAX_SAFE_INTEGER))).toBeNull();
    expect(sanitizeElement(el("v", Number.MAX_SAFE_INTEGER, { isDeleted: true }))).toBeNull();
    expect(sanitizeElement(el("v", 1, { versionNonce: -Number.MAX_SAFE_INTEGER }))).toBeNull();
    expect(sanitizeElement(el("v", 1, { versionNonce: -MAX_VERSION }))).not.toBeNull();
    expect(elementId({ id: "abc", version: "x" })).toBe("abc");
    expect(elementId({ id: "../x" })).toBeNull();
    expect(elementId(null)).toBeNull();
  });

  it("Dateinamen", () => {
    expect(boardFileName("Brüche ")).toBe("Brüche.excalidraw");
    expect(boardFileName("Plan.excalidraw")).toBe("Plan.excalidraw");
    expect(isBoardName("Plan.EXCALIDRAW")).toBe(true);
    expect(isBoardName(".excalidraw")).toBe(false);
    expect(isBoardName("Plan.pdf")).toBe(false);
    expect(boardTitle("Plan.excalidraw")).toBe("Plan");
  });
});
