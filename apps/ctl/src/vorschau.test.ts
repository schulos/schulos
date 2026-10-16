import { describe, expect, it } from "vitest";
import { buildManifest } from "@schulos/server/release";
import { isExternSite, previewDomain, previewTarget, VORSCHAU_PROFIL_EXTERN, vorschauSite } from "./vorschau";

const d64 = (c: string) => "sha256:" + c.repeat(64);
const now = new Date("2026-10-05T10:00:00Z");
const rel = (version: string, publishedAt = "2026-10-01T00:00:00Z") =>
  buildManifest({
    version,
    notes: { changes: [{ kind: "neu", text: "x neu" }] },
    images: { app: `ghcr.io/x/a@${d64("a")}`, backup: `ghcr.io/x/b@${d64("b")}`, agent: `ghcr.io/x/c@${d64("c")}` },
    commit: "abc1234",
    publishedAt: new Date(publishedAt),
  });

describe("Vorschau-Instanz", () => {
  it("G4E-O16: --extern erkennbar an der Site; Schulprofil und --extern schließen sich aus", () => {
    expect(isExternSite(vorschauSite("vorschau.schule.de", { extern: true }))).toBe(true);
    expect(isExternSite(vorschauSite("vorschau.schule.de"))).toBe(false);
    expect(VORSCHAU_PROFIL_EXTERN).toContain("vorschau profil --aus");
  });

  it("zeigt die nächste Version aus beta (auch Vorabversionen), sonst die laufende", () => {
    const all = [rel("1.4.0"), rel("1.5.0"), rel("1.6.0-rc.1")];
    expect(previewTarget("1.4.0", all, now)?.version).toBe("1.6.0-rc.1");
    expect(previewTarget("1.6.0-rc.1", all, now)).toBeNull();
  });

  it("Adresse und Caddy-Site", () => {
    expect(previewDomain("schulos.gs-musterstadt.de")).toBe("vorschau.schulos.gs-musterstadt.de");
    expect(previewDomain("x.de", "Test.Schule.DE")).toBe("test.schule.de");
    expect(() => previewDomain("x.de", "evil.de {\n respond 1\n}")).toThrow("Ungültige Adresse");
    const site = vorschauSite("vorschau.schule.de");
    expect(site).toContain("vorschau.schule.de {");
    expect(site).toContain("reverse_proxy schulos-vorschau:3000");
    expect(site).toContain("tls {$SCHULOS_TLS}");
    // Snippet aus compose.yaml – die App komprimiert nicht selbst (B-56)
    expect(site).toContain("import kompression");
  });

  it("GATE-4c: per Vorgabe nur im Schulnetz – von außen 403; --extern nur gekennzeichnet; Kennzeichen immer verworfen", () => {
    const intern = vorschauSite("vorschau.schule.de");
    // dieselbe Unterscheidung wie die Haupt-Site (compose.yaml)
    expect(intern).toContain("@extern not client_ip {$SCHULOS_INTERNAL_NETS:private_ranges}");
    expect(intern).toMatch(/handle @extern \{\s*respond "[^"]*nur im Schulnetz[^"]*" 403\s*\}/);
    // der einzige Weg zur App liegt im Zweig ohne @extern
    expect(intern.match(/reverse_proxy/g)).toHaveLength(1);
    expect(intern.indexOf("reverse_proxy")).toBeGreaterThan(intern.indexOf("  handle {"));
    const extern = vorschauSite("vorschau.schule.de", { extern: true });
    for (const site of [intern, extern]) {
      expect(site.indexOf("request_header -X-SchulOS-Extern")).toBeLessThan(site.indexOf("handle @extern"));
      expect(site).toContain("request_header -X-SchulOS-Geraet");
      expect(site).toContain("header_up X-Forwarded-For {client_ip}");
      // Klammern ausgeglichen (sonst lädt Caddy die ganze Konfiguration nicht)
      expect((site.match(/\{/g) ?? []).length).toBe((site.match(/\}/g) ?? []).length);
    }
    expect(extern).toMatch(/handle @extern \{\s*request_header X-SchulOS-Extern alles\s*reverse_proxy schulos-vorschau:3000/);
    expect(extern).not.toContain("403");
    expect(extern).toContain("AUCH VON AUSSEN");
  });
});
