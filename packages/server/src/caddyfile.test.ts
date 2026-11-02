import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);

// Clients ohne SNI (Aufruf über die IP-Adresse) bekommen sonst einen TLS-Fehler (INST-04)
describe("Caddyfile: default_sni", () => {
  it("Hauptsystem: Zertifikat der Domain", () => {
    expect(readFileSync(new URL("compose.yaml", root), "utf8")).toContain("default_sni {$$SCHULOS_DOMAIN}");
  });

  it("Backupserver: Zertifikat der Backup-Domain, im globalen Block vor dem Site-Block", () => {
    const text = readFileSync(new URL("compose.backup.yaml", root), "utf8");
    const caddyfile = text.slice(text.indexOf("\nconfigs:"));
    const sni = caddyfile.indexOf("default_sni {$$SCHULOS_BACKUP_DOMAIN}");
    expect(sni).toBeGreaterThan(-1);
    expect(sni).toBeLessThan(caddyfile.indexOf("{$$SCHULOS_BACKUP_DOMAIN}, https:// {"));
  });
});

// INST-10: Aufruf über die IP bzw. einen fremden Namen – Host passt sonst auf keinen Block (leere 200), unbekannte SNI
// endet sonst im TLS-Fehler. Das Verhalten prüfen scripts/ci/per-ip.sh (CI-Jobs „stack“ und „backup“).
describe("Caddyfile: Catch-all für IP und fremde Namen", () => {
  it("Hauptsystem: Site-Block auch für https:// ohne Namen, fallback_sni auf die Domain", () => {
    const text = readFileSync(new URL("compose.yaml", root), "utf8");
    expect(text).toContain("fallback_sni {$$SCHULOS_DOMAIN}");
    expect(text).toContain("{$$SCHULOS_DOMAIN}, https:// {");
  });

  it("Backupserver: Catch-all, fallback_sni und interne API über Caddy gesperrt (vor allen Weiterleitungen)", () => {
    const text = readFileSync(new URL("compose.backup.yaml", root), "utf8");
    const caddyfile = text.slice(text.indexOf("\nconfigs:"));
    expect(caddyfile).toContain("fallback_sni {$$SCHULOS_BACKUP_DOMAIN}");
    const site = caddyfile.indexOf("{$$SCHULOS_BACKUP_DOMAIN}, https:// {");
    expect(site).toBeGreaterThan(-1);
    const intern = caddyfile.indexOf("@intern path /api/intern /api/intern/*");
    expect(intern).toBeGreaterThan(site);
    expect(intern).toBeLessThan(caddyfile.indexOf("reverse_proxy backup:3100"));
  });
});

// P4-73: Service Worker nie aus einem Zwischenspeicher – nach einem Update muss der neue Worker sofort greifen
describe("Caddyfile: /sw.js ohne Cache", () => {
  it("Hauptsystem setzt Cache-Control für /sw.js nach der Antwort der App", () => {
    expect(readFileSync(new URL("compose.yaml", root), "utf8")).toContain('header /sw.js >Cache-Control "no-cache, no-store, must-revalidate"');
  });
});

// ZERTIFIKATE.md Teil A: http://<IP> bzw. fremder Name → Hinweisseite statt Weiterleitung auf https://<IP> (Zertifikatswarnung).
// Das Verhalten prüft scripts/ci/per-ip.sh (CI-Job „stack“).
describe("Caddyfile: Hinweisseite bei Aufruf per http:// mit IP oder fremdem Namen", () => {
  const text = readFileSync(new URL("compose.yaml", root), "utf8");
  const block = text.slice(text.indexOf("      http:// {"), text.indexOf("      import /etc/caddy/sites/*.caddy"));

  it("eigener http-Block nach dem https-Block: Domain und von außen weiter auf https, /ca.crt an die App, sonst Hinweisseite", () => {
    expect(text.indexOf("      http:// {")).toBeGreaterThan(text.indexOf("{$$SCHULOS_DOMAIN}, https:// {"));
    const domain = block.indexOf("handle @domain {");
    const extern = block.indexOf("handle @extern {");
    const ca = block.indexOf("handle /ca.crt {");
    const hinweis = block.indexOf("root * /etc/schulos/adresshinweis");
    expect(block).toContain("@domain host {$$SCHULOS_DOMAIN}");
    expect(block).toContain("@extern not client_ip {$$SCHULOS_INTERNAL_NETS:private_ranges}");
    expect(domain).toBeGreaterThan(-1);
    expect(extern).toBeGreaterThan(domain);
    expect(ca).toBeGreaterThan(extern);
    expect(hinweis).toBeGreaterThan(ca);
    // Kennzeichen „von außen“/Gerät setzt nur Caddy – auch über http verwerfen, bevor die App fragt
    const caBlock = block.slice(ca, hinweis);
    expect(caBlock).toContain("request_header -X-SchulOS-Extern");
    expect(caBlock).toContain("request_header -X-SchulOS-Geraet");
  });

  it("Vorlage eingehängt, aufgerufener Name nur maskiert, Zertifikat nur bei eigener CA", () => {
    expect(text).toContain("target: /etc/schulos/adresshinweis/index.html");
    const tpl = text.slice(text.indexOf("\n  adresshinweis:"), text.indexOf("\n  # B-51"));
    expect(tpl).toContain("{{html .Host}}");
    expect(tpl.match(/\.Host/g)).toHaveLength(1);
    expect(tpl).toMatch(/\{\{if eq \(env "SCHULOS_TLS"\) "internal"\}\}[\s\S]*href="\/ca\.crt"[\s\S]*\{\{end\}\}/);
  });
});
