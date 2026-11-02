// CA-06/CA-07: DNS-Prüfung – Anbieterliste (dns.ts), Caddy-Snippets (compose.yaml), Caddy-Module (deploy/caddy-dns) und die
// Weitergabe der Zugangsdaten passen zusammen. Am echten Image prüft scripts/caddy-dns-test.sh (CI-Job „stack“).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DNS_ENV, DNS_PROVIDERS, dnsFields, isCloudflareToken } from "./dns";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const compose = parse(read("compose.yaml"), { merge: true }) as {
  services: Record<string, { environment?: Record<string, string> }>;
  configs: Record<string, { content: string }>;
};
const caddyfile = compose.configs.caddyfile!.content;
/** Rumpf eines Snippets `(name) { … }` (Einrückung wie in compose.yaml: Snippet-Ende = „}“ ganz links) */
function snippet(name: string): string | null {
  const m = new RegExp(`^\\(${name}\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(caddyfile);
  return m ? m[1]! : null;
}
// Linux (CI): Ersatz-„caddy“ über PATH – unter Windows (Git Bash) ließe sich PATH so nicht sauber setzen
const hasShell = process.platform !== "win32" && spawnSync("sh", ["-c", "true"]).status === 0;

describe("CA-06: Anbieter, Snippets und Module passen zusammen", () => {
  it("je Anbieter ein Snippet, das genau seine Zugangsdaten als Laufzeit-Platzhalter nutzt", () => {
    for (const p of DNS_PROVIDERS) {
      const body = snippet(`tls-dns-${p.value}`);
      expect(body, p.value).not.toBeNull();
      expect(body).toContain(`dns ${p.value}`);
      expect(body).toContain("import tls-dns-gemeinsam");
      const used = new Set([...body!.matchAll(/\{env\.(SCHULOS_DNS_[A-Z_]+)\}/g)].map((m) => m[1]));
      expect([...used].sort(), p.value).toEqual([...new Set(dnsFields(p.value).map((f) => DNS_ENV[f]))].sort());
      // nie zur Lesezeit eingesetzt ({$…}) – sonst stünde das Geheimnis in der umgewandelten Konfiguration
      expect(body).not.toMatch(/\{\$\$?SCHULOS_DNS_(TOKEN|SECRET|USER)/);
    }
    // keine Snippets für unbekannte Anbieter
    const all = [...caddyfile.matchAll(/^\(tls-dns-([a-z0-9]+)\)/gm)].map((m) => m[1]);
    expect(all.sort()).toEqual(["aus", "gemeinsam", ...DNS_PROVIDERS.map((p) => p.value)].sort());
    expect(snippet("tls-dns-aus")!.trim()).toBe("");
    expect(caddyfile).toContain("import tls-dns-{$$SCHULOS_TLS_DNS:aus}");
    expect(snippet("tls-acme-staging-1")).toContain("acme-staging-v02.api.letsencrypt.org");
    expect(snippet("tls-acme-staging-0")!.trim()).toBe("");
  });

  it("Caddy bekommt jede Variable (leer als Vorgabe), Standard bleibt caddy:2 ohne DNS", () => {
    const env = compose.services.caddy!.environment!;
    for (const v of new Set(Object.values(DNS_ENV))) expect(env[v], v).toMatch(new RegExp(`^\\$\\{${v}:-`));
    expect(env.SCHULOS_TLS_DNS).toBe("${SCHULOS_TLS_DNS:-aus}");
    expect(env.SCHULOS_ACME_STAGING).toBe("${SCHULOS_ACME_STAGING:-0}");
    expect(read("compose.yaml")).toContain("image: ${SCHULOS_CADDY_IMAGE:-caddy:2}");
    // die App sieht keinen Zugang zum DNS-Anbieter
    expect(Object.keys(compose.services.app!.environment ?? {}).filter((k) => k.startsWith("SCHULOS_DNS_"))).toEqual([]);
  });

  it("CA-07: das Caddy-Image bringt genau die Module der Anbieterliste mit (main.go, go.mod)", () => {
    const main = read("deploy/caddy-dns/main.go");
    const mod = read("deploy/caddy-dns/go.mod");
    const imported = [...main.matchAll(/_ "github\.com\/caddy-dns\/([a-z0-9]+)(?:\/v\d+)?"/g)].map((m) => m[1]);
    expect(imported.sort()).toEqual(DNS_PROVIDERS.map((p) => p.value).sort());
    for (const p of imported) expect(mod).toMatch(new RegExp(`github\\.com/caddy-dns/${p}(/v\\d+)? v\\d`));
    expect(mod).toMatch(/github\.com\/caddyserver\/caddy\/v2 v2\./);
    // go.sum liegt im Repo (jede Abhängigkeit per Prüfsumme), der Bau verändert go.mod nicht
    expect(read("deploy/caddy-dns/go.sum")).toContain("github.com/caddyserver/caddy/v2");
    const dockerfile = read("deploy/caddy-dns/Dockerfile");
    expect(dockerfile).toContain("-mod=readonly");
    expect(dockerfile).toContain("GOTOOLCHAIN=local");
    expect(dockerfile).toMatch(/^ARG GO_IMAGE=golang:/m);
    expect(dockerfile).toMatch(/^ARG CADDY_IMAGE=caddy:2$/m);
  });

  it("CA-07: Dependabot hält Go-Module und Go-Basis aktuell", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toMatch(/package-ecosystem: gomod\n\s+directory: \/deploy\/caddy-dns/);
    expect(read("deploy/upstream/Dockerfile")).toMatch(/^FROM golang:[^@]+@sha256:[0-9a-f]{64} AS golang$/m);
  });

  it("Cloudflare-Token im Format, das das Modul verlangt (sonst stünde er in dessen Fehlermeldung)", () => {
    expect(isCloudflareToken("a".repeat(40))).toBe(true);
    expect(isCloudflareToken(`cfut_${"b".repeat(40)}`)).toBe(true);
    expect(isCloudflareToken('"' + "a".repeat(40) + '"')).toBe(false);
    expect(isCloudflareToken("kurz")).toBe(false);
  });
});

describe.skipIf(!hasShell)("CA-07: caddy-start bricht ohne DNS-Modul verständlich ab", () => {
  const start = compose.configs["caddy-start"]!.content.replaceAll("$$", "$");
  // nur der Teil vor dem CA-01-Teil (der braucht /data) – mit einem caddy-Ersatz, der Module aufzählt
  const guard = start.slice(0, start.indexOf("L=/data/caddy"));
  const run = (env: Record<string, string>, modules: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "caddy-start-"));
    try {
      writeFileSync(path.join(dir, "caddy"), `#!/bin/sh\nprintf '%s\\n' ${modules}\n`, { mode: 0o755 });
      const r = spawnSync("sh", ["-c", `${guard}\necho weiter`], { env: { PATH: `${dir}${path.delimiter}${process.env.PATH}`, ...env }, encoding: "utf8" });
      return { code: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("ohne DNS-Prüfung und mit passendem Modul geht es weiter, sonst Abbruch mit Hinweis", () => {
    expect(run({}, "http.handlers.file_server")).toMatchObject({ code: 0, out: "weiter\n" });
    expect(run({ SCHULOS_TLS_DNS: "aus" }, "")).toMatchObject({ code: 0 });
    expect(run({ SCHULOS_TLS_DNS: "hetzner", SCHULOS_TLS: "it@schule.de" }, "dns.providers.hetzner")).toMatchObject({ code: 0 });
    const ohne = run({ SCHULOS_TLS_DNS: "hetzner", SCHULOS_TLS: "it@schule.de" }, "dns.providers.cloudflare");
    expect(ohne.code).toBe(1);
    expect(ohne.out).toContain("SCHULOS_CADDY_DNS_IMAGE");
    const intern = run({ SCHULOS_TLS_DNS: "hetzner", SCHULOS_TLS: "internal" }, "dns.providers.hetzner");
    expect(intern.code).toBe(1);
    expect(intern.out).toContain("SCHULOS_TLS=<E-Mail-Adresse>");
  });
});
