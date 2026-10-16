import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "@/modules";
import { DSB_TOPICS, renderChecklistDoc, topicMarkdown } from "./checkliste";

const settings = MODULES.flatMap((m) => m.settings ?? []);
const doc = readFileSync(path.join(process.cwd(), "docs", "DSB-FRAGEN.md"), "utf8").replace(/\r\n/g, "\n");

describe("DSB-Checkliste (DS-13)", () => {
  it("Kennungen und Nummern sind eindeutig", () => {
    expect(new Set(DSB_TOPICS.map((t) => t.id)).size).toBe(DSB_TOPICS.length);
    expect(new Set(DSB_TOPICS.map((t) => t.nr)).size).toBe(DSB_TOPICS.length);
  });

  it("docs/DSB-FRAGEN.md hat genau diese Themen in dieser Reihenfolge", () => {
    const headings = [...doc.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    expect(headings).toEqual(DSB_TOPICS.map((t) => `${t.nr}. ${t.title}`));
  });

  it("die Kurzfassungen in der Doku sind aus der Datenquelle erzeugt (sonst: npx tsx scripts/dsb-checkliste.ts)", () => {
    for (const t of DSB_TOPICS) expect(doc, t.id).toContain(`<!-- dsb:${t.id} -->\n${topicMarkdown(t, settings)}\n<!-- /dsb -->`);
    expect(renderChecklistDoc(doc, settings)).toBe(doc);
  });

  it("jede Moduleinstellung gehört zu genau einem Thema, jedes genannte Thema-Schalter existiert", () => {
    const referenced = DSB_TOPICS.flatMap((t) => t.settings ?? []);
    expect(new Set(referenced).size).toBe(referenced.length);
    expect([...referenced].sort()).toEqual(settings.map((s) => s.key).sort());
  });

  it("Erzeugung: Einstellung mit Vorgabe-Beschriftung, Tabellen-Trenner maskiert", () => {
    const md = topicMarkdown({ id: "x", nr: 99, title: "T", schulos: "a | b", vorgabe: "v", schule: "s", settings: ["messenger.counseling_chat"] }, settings);
    expect(md).toContain("a \\| b");
    expect(md).toContain("„Chats mit der Schulsozialarbeit (Rolle Beratung)“ (Vorgabe: aus – nur Kontaktangaben im Adressbuch)");
  });

  it("Marker können nicht über ein Thema hinaus ersetzen (leere Blöcke)", () => {
    const raw = "<!-- dsb:verantwortung -->\n<!-- /dsb -->\nZWISCHEN\n<!-- dsb:krankmeldungen -->\n<!-- /dsb -->\n";
    const out = renderChecklistDoc(raw, settings);
    expect(out).toContain("ZWISCHEN");
    expect(out.match(/<!-- \/dsb -->/g)).toHaveLength(2);
  });
});
