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
