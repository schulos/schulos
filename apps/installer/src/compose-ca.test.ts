// CA-01: CA-Schlüssel (Caddy, Schul-CA) ins Backup und zurück – statisch an compose.yaml geprüft. Am laufenden Stack prüft
// scripts/backup-stack-test.sh (CI-Job „backup“): Sicherung enthält die Wurzel, nach der Wiederherstellung dieselbe Wurzel.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../../..");
const compose = parse(readFileSync(path.join(ROOT, "compose.yaml"), "utf8"), { merge: true }) as {
  services: Record<string, { volumes?: string[]; group_add?: string[]; entrypoint?: string[]; configs?: { source: string; target: string }[] }>;
  configs: Record<string, { content: string }>;
  volumes: Record<string, unknown>;
};
const svc = compose.services;
/** Inhalt eines Startskripts, wie ihn der Container sieht ($$ → $) */
const script = (name: string) => compose.configs[name]!.content.replaceAll("$$", "$");
const hasShell = spawnSync("sh", ["-c", "true"]).status === 0;

describe("CA-01: CA-Schlüssel im Backup", () => {
  it("Backup-Agent liest caddy_data und step_ca nur, schreibt nur in die Übergabeordner", () => {
    const v = svc["backup-agent"]!.volumes!;
    expect(v).toContain("caddy_data:/srv/schulos/caddy-data:ro");
    expect(v).toContain("step_ca:/srv/schulos/step-ca:ro");
    expect(v).toContain("ca_rueckspiel_caddy:/srv/schulos/rueckspiel-caddy");
    expect(v).toContain("ca_rueckspiel_step:/srv/schulos/rueckspiel-step-ca");
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(["ca_rueckspiel_caddy", "ca_rueckspiel_step"]));
    // die Übergabe sieht jeweils nur der Dienst, dem sie gehört
    expect(svc.caddy!.volumes).toContain("ca_rueckspiel_caddy:/rueckspiel");
    expect(svc["step-ca"]!.volumes).toContain("ca_rueckspiel_step:/rueckspiel");
    expect(svc.app!.volumes!.join(" ")).not.toMatch(/caddy_data|step_ca|rueckspiel/);
    expect(svc.caddy!.volumes!.join(" ")).not.toContain("ca_rueckspiel_step");
    expect(svc["step-ca"]!.volumes!.join(" ")).not.toContain("ca_rueckspiel_caddy");
  });

  it("Caddy: Startskript mit Gruppe 1000 (Leserecht für den Agenten) statt zusätzlicher Capability", () => {
    expect(svc.caddy!.group_add).toEqual(["1000"]);
    expect(svc.caddy!.entrypoint).toEqual(["sh", "/etc/schulos/caddy-start.sh"]);
    expect(svc.caddy!.configs).toContainEqual({ source: "caddy-start", target: "/etc/schulos/caddy-start.sh" });
    const s = script("caddy-start");
    expect(s).toContain("exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile");
    // übernommen wird mit 600, nur wenn beide Dateien da sind; Zwischen- und Serverzertifikate der alten Kette weg
    expect(s).toMatch(/\[ -s "\$T\/root\.crt" \] && \[ -s "\$T\/root\.key" \]/);
    expect(s).toContain('chmod 600 "$L/root.key.neu"');
    expect(s).toContain('rm -f "$L/intermediate.crt" "$L/intermediate.key"');
    expect(s).toContain("rm -rf /data/caddy/certificates/local");
    // Leserecht nur auf Wurzel und Weg dorthin, nie auf intermediate.key oder den ganzen Ordner; keine Inhalte ins Protokoll
    expect(s).not.toMatch(/chmod -R|chgrp -R|intermediate\.key" *&& *chmod/);
    expect(s).not.toMatch(/cat "?\$[LT]|echo .*root\.key/);
  });

  it("step-ca übernimmt nur einen vollständigen Stand (config/ca.json) aus der Übergabe", () => {
    const s = script("step-ca-start");
    const imp = s.indexOf("/rueckspiel/stand/config/ca.json");
    expect(imp).toBeGreaterThan(0);
    expect(imp).toBeLessThan(s.indexOf("step ca init")); // vor dem Anlegen einer neuen CA
    expect(s).toContain("rm -rf /rueckspiel/stand");
    expect(svc["geraete-ca-init"]!.volumes).toContain("ca_rueckspiel_step:/rueckspiel");
  });

  it.skipIf(!hasShell)("Startskripte sind gültige Shell-Skripte", () => {
    for (const [name, shell] of [["caddy-start", "sh"], ["step-ca-start", "bash"]] as const) {
      const r = spawnSync(shell, ["-n"], { input: script(name), encoding: "utf8" });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
  });
});
