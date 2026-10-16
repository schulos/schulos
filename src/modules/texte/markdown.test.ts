import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendBlocks, docToMarkdown, docToText, FRAGMENT, MAX_DEPTH } from "./markdown";

describe("Texte – Markdown-Export", () => {
  it("Überschriften, Absätze mit Auszeichnung, Listen, Zitat, Code", () => {
    const doc = new Y.Doc();
    appendBlocks(doc, [
      { type: "heading", level: 1, runs: ["Protokoll"] },
      { type: "paragraph", runs: ["Wir haben ", { text: "drei", bold: true }, " Punkte ", { text: "besprochen", italic: true }, "."] },
      { type: "bulletList", items: [["Erster Punkt"], [{ text: "Code", code: true }, " im zweiten"]] },
      { type: "orderedList", start: 3, items: [["drei"], ["vier"]] },
      { type: "blockquote", runs: ["Zitat"] },
      { type: "codeBlock", code: "const a = 1;\nconsole.log(a);", language: "ts" },
      { type: "paragraph", runs: [{ text: "Schule", link: "https://example.org/a b" }] },
    ]);
    expect(docToMarkdown(doc)).toBe(
      [
        "# Protokoll",
        "",
        "Wir haben **drei** Punkte *besprochen*.",
        "",
        "- Erster Punkt",
        "- `Code` im zweiten",
        "",
        "3. drei",
        "4. vier",
        "",
        "> Zitat",
        "",
        "```ts",
        "const a = 1;",
        "console.log(a);",
        "```",
        "",
        "[Schule](https://example.org/a%20b)",
        "",
      ].join("\n"),
    );
    expect(docToText(doc)).toBe("Protokoll\nWir haben drei Punkte besprochen.\nErster Punkt\nCode im zweiten\ndrei\nvier\nZitat\nconst a = 1;\nconsole.log(a);\nSchule");
  });

  it("entschärft Markdown-Zeichen im Text, nicht im Code; nur http(s)-Links werden verlinkt", () => {
    const doc = new Y.Doc();
    appendBlocks(doc, [
      { type: "paragraph", runs: ["2 * 3 = 6, siehe [Anhang] und <b>"] },
      { type: "paragraph", runs: [{ text: "a*b", code: true }] },
      { type: "paragraph", runs: [{ text: "klick", link: "javascript:alert(1)" }] },
    ]);
    expect(docToMarkdown(doc)).toBe("2 \\* 3 = 6, siehe \\[Anhang\\] und \\<b\\>\n\n`a*b`\n\nklick\n");
  });

  it("P311-04: Code-Spans nach CommonMark (längerer Zaun, Leerzeichen am Rand), „!“ vor Links wird kein Bild", () => {
    const doc = new Y.Doc();
    appendBlocks(doc, [
      { type: "paragraph", runs: [{ text: "a`b", code: true }] },
      { type: "paragraph", runs: [{ text: "``x``", code: true }] },
      { type: "paragraph", runs: [{ text: "`", code: true }] },
      { type: "paragraph", runs: ["Achtung!", { text: "Link", link: "https://example.org/" }] },
    ]);
    expect(docToMarkdown(doc)).toBe("``a`b``\n\n``` ``x`` ```\n\n`` ` ``\n\nAchtung\\![Link](https://example.org/)\n");
  });

  it("P311-03: 3000-fach verschachtelte Zitate – Export bleibt flach statt im Stack zu scheitern", () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT);
    doc.transact(() => {
      let parent: Y.XmlFragment | Y.XmlElement = frag;
      for (let i = 0; i < 3000; i++) {
        const q = new Y.XmlElement("blockquote");
        parent.insert(0, [q]);
        parent = q;
      }
      const p = new Y.XmlElement("paragraph");
      const t = new Y.XmlText();
      t.insert(0, "ganz innen");
      p.insert(0, [t]);
      parent.insert(0, [p]);
    });
    const md = docToMarkdown(doc);
    expect(md.startsWith("> ".repeat(MAX_DEPTH))).toBe(true);
    expect(md).toContain("ganz innen");
    expect(docToText(doc)).toBe("ganz innen");
  });

  it("leeres Dokument → leerer Export; harte Umbrüche und verschachtelte Listen wie von y-prosemirror", () => {
    const empty = new Y.Doc();
    expect(docToMarkdown(empty)).toBe("");
    expect(docToText(empty)).toBe("");

    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT);
    const p = new Y.XmlElement("paragraph");
    const t1 = new Y.XmlText();
    t1.insert(0, "Zeile eins");
    const br = new Y.XmlElement("hardBreak");
    const t2 = new Y.XmlText();
    t2.insert(0, "Zeile zwei");
    p.insert(0, [t1, br, t2]);
    const list = new Y.XmlElement("bulletList");
    const li = new Y.XmlElement("listItem");
    const lp = new Y.XmlElement("paragraph");
    const lt = new Y.XmlText();
    lt.insert(0, "außen");
    lp.insert(0, [lt]);
    const inner = new Y.XmlElement("bulletList");
    const ili = new Y.XmlElement("listItem");
    const ip = new Y.XmlElement("paragraph");
    const it2 = new Y.XmlText();
    it2.insert(0, "innen");
    ip.insert(0, [it2]);
    ili.insert(0, [ip]);
    inner.insert(0, [ili]);
    li.insert(0, [lp, inner]);
    list.insert(0, [li]);
    frag.insert(0, [p, list, new Y.XmlElement("horizontalRule")]);
    expect(docToMarkdown(doc)).toBe("Zeile eins  \nZeile zwei\n\n- außen\n  - innen\n\n---\n");
  });
});
