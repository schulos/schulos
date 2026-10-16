// Export (P3-11): Yjs-Dokument (Struktur von @tiptap/y-tiptap bzw. y-prosemirror: XmlElement je Knoten, XmlText mit
// Formatierungen je Textlauf) → Markdown bzw. Klartext. Deckt die Knoten des Tiptap-StarterKits ab; Unbekanntes wird als
// Absatz ausgegeben. Rein (keine DB, kein ProseMirror) – läuft auf dem Server für Download und Druckansicht.
import * as Y from "yjs";

/** Name des Fragments, das Tiptaps Collaboration-Erweiterung ohne Angabe nutzt */
export const FRAGMENT = "default";

/**
 * Tiefer verschachtelte Blöcke (Zitat in Zitat in …) gibt der Export flach als Text aus (P311-03): ein Client kann per
 * Update beliebig tief schachteln, und die Rekursion darf daran nicht scheitern (Stack).
 */
export const MAX_DEPTH = 50;

type Attrs = Record<string, unknown>;
type Delta = { insert: string | object; attributes?: Attrs };

/** Sonderzeichen im Fließtext entschärfen (nur die, die Markdown sonst als Auszeichnung liest; `!` wegen `![…](…)`) */
function escapeText(s: string): string {
  return s.replace(/([\\*_`[\]~<>!])/g, "\\$1");
}

/** Code-Span nach CommonMark: Backtick-Zaun länger als jede Backtick-Folge im Inhalt, Leerzeichen, wenn er mit ` beginnt/endet */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") || (code.startsWith(" ") && code.endsWith(" ") && code.trim()) ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function deltaText(t: Y.XmlText): string {
  return (t.toDelta() as Delta[]).map((d) => (typeof d.insert === "string" ? d.insert : "")).join("");
}

function children(el: Y.XmlFragment | Y.XmlElement): (Y.XmlText | Y.XmlElement)[] {
  return el.toArray().filter((c): c is Y.XmlText | Y.XmlElement => c instanceof Y.XmlText || c instanceof Y.XmlElement);
}

/**
 * Klartext eines Teilbaums ohne Rekursion (Stapel): Zeilenumbruch hinter jedem Textblock (Absatz, Überschrift …), nicht
 * hinter Containern (Liste, Listeneintrag).
 */
function plainText(root: Y.XmlFragment | Y.XmlElement): string {
  let out = "";
  const stack: (Y.XmlText | Y.XmlElement | "\n")[] = children(root).reverse();
  while (stack.length) {
    const c = stack.pop()!;
    if (c === "\n") out += "\n";
    else if (c instanceof Y.XmlText) out += deltaText(c);
    else if (c.nodeName === "hardBreak") out += "\n";
    else {
      const kids = children(c);
      if (kids.some((x) => x instanceof Y.XmlText)) stack.push("\n");
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return out;
}

function inline(node: Y.XmlText | Y.XmlElement, depth: number): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as Delta[])
      .map((d) => {
        if (typeof d.insert !== "string") return "";
        const a = d.attributes ?? {};
        let s = a.code ? codeSpan(d.insert) : escapeText(d.insert);
        if (a.bold) s = `**${s}**`;
        if (a.italic) s = `*${s}*`;
        if (a.strike) s = `~~${s}~~`;
        const link = a.link as { href?: string } | undefined;
        if (link?.href && /^https?:\/\//i.test(link.href)) s = `[${s}](${link.href.replace(/[()\s]/g, encodeURIComponent)})`;
        return s;
      })
      .join("");
  }
  if (node.nodeName === "hardBreak") return "  \n";
  if (depth > MAX_DEPTH) return escapeText(plainText(node));
  return children(node)
    .map((c) => inline(c, depth + 1))
    .join("");
}

/** Textinhalt eines Blockknotens (Absatz, Überschrift …) */
function textOf(el: Y.XmlElement, depth: number): string {
  return children(el)
    .map((c) => inline(c, depth))
    .join("")
    .replace(/\s+$/g, "");
}

function prefixLines(s: string, first: string, rest: string): string {
  return s
    .split("\n")
    .map((line, i) => (i === 0 ? first : rest) + line)
    .join("\n");
}

function block(node: Y.XmlText | Y.XmlElement, depth: number): string {
  if (node instanceof Y.XmlText) return inline(node, depth);
  if (depth > MAX_DEPTH) return escapeText(plainText(node).trim());
  const attr = (k: string) => node.getAttribute(k) as unknown;
  switch (node.nodeName) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(attr("level") ?? 1) || 1));
      return `${"#".repeat(level)} ${textOf(node, depth)}`;
    }
    case "paragraph":
      return textOf(node, depth);
    case "bulletList":
      return children(node)
        .map((li) => prefixLines(blocks(li instanceof Y.XmlElement ? li : node, depth + 1), "- ", "  "))
        .join("\n");
    case "orderedList": {
      const start = Number(attr("start") ?? 1) || 1;
      return children(node)
        .map((li, i) => prefixLines(blocks(li instanceof Y.XmlElement ? li : node, depth + 1), `${start + i}. `, "   "))
        .join("\n");
    }
    case "blockquote":
      return prefixLines(blocks(node, depth + 1), "> ", "> ");
    case "codeBlock": {
      const lang = String(attr("language") ?? "").replace(/[^\w+-]/g, "");
      const code = children(node)
        .map((c) => (c instanceof Y.XmlText ? deltaText(c) : ""))
        .join("");
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case "horizontalRule":
      return "---";
    case "listItem":
      return blocks(node, depth + 1);
    default:
      return textOf(node, depth);
  }
}

/** Blöcke eines Containers, durch Leerzeilen getrennt (in Listen ohne Leerzeile, damit es eine Liste bleibt) */
function blocks(el: Y.XmlFragment | Y.XmlElement, depth: number): string {
  const inList = el instanceof Y.XmlElement && el.nodeName === "listItem";
  return children(el)
    .map((c) => block(c, depth))
    .join(inList ? "\n" : "\n\n");
}

/** Das ganze Dokument als Markdown (GFM-tauglich, ohne Roh-HTML). */
export function docToMarkdown(doc: Y.Doc): string {
  const md = blocks(doc.getXmlFragment(FRAGMENT), 0).trim();
  return md ? `${md}\n` : "";
}

/** Klartext ohne Auszeichnung – für Vorschau und Suche. */
export function docToText(doc: Y.Doc): string {
  return plainText(doc.getXmlFragment(FRAGMENT))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ------------------------------------------------------------- Inhalte erzeugen (Seed, Tests)

export type Run = string | { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string };
export type Block =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "bulletList"; items: Run[][] }
  | { type: "orderedList"; items: Run[][]; start?: number }
  | { type: "blockquote"; runs: Run[] }
  | { type: "codeBlock"; code: string; language?: string };

function textNode(runs: Run[]): Y.XmlText {
  const t = new Y.XmlText();
  let pos = 0;
  for (const r of runs) {
    const run = typeof r === "string" ? { text: r } : r;
    const attrs: Attrs = {};
    if (run.bold) attrs.bold = {};
    if (run.italic) attrs.italic = {};
    if (run.code) attrs.code = {};
    if (run.link) attrs.link = { href: run.link };
    t.insert(pos, run.text, attrs); // immer Attribute angeben – ohne erbt Yjs die Formatierung des vorigen Laufs
    pos += run.text.length;
  }
  return t;
}

function paragraph(runs: Run[]): Y.XmlElement {
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [textNode(runs)]);
  return p;
}

/** Blöcke in das Dokument einfügen (ans Ende) – Struktur wie vom Editor (@tiptap/y-tiptap) erzeugt. */
export function appendBlocks(doc: Y.Doc, list: Block[]): void {
  const frag = doc.getXmlFragment(FRAGMENT);
  doc.transact(() => {
    for (const b of list) {
      let el: Y.XmlElement;
      switch (b.type) {
        case "heading":
          el = new Y.XmlElement("heading");
          el.setAttribute("level", b.level as unknown as string);
          el.insert(0, [textNode(b.runs)]);
          break;
        case "paragraph":
          el = paragraph(b.runs);
          break;
        case "bulletList":
        case "orderedList":
          el = new Y.XmlElement(b.type);
          if (b.type === "orderedList" && b.start) el.setAttribute("start", b.start as unknown as string);
          el.insert(
            0,
            b.items.map((runs) => {
              const li = new Y.XmlElement("listItem");
              li.insert(0, [paragraph(runs)]);
              return li;
            }),
          );
          break;
        case "blockquote":
          el = new Y.XmlElement("blockquote");
          el.insert(0, [paragraph(b.runs)]);
          break;
        case "codeBlock": {
          el = new Y.XmlElement("codeBlock");
          if (b.language) el.setAttribute("language", b.language);
          const t = new Y.XmlText();
          t.insert(0, b.code);
          el.insert(0, [t]);
          break;
        }
      }
      frag.insert(frag.length, [el]);
    }
  });
}
