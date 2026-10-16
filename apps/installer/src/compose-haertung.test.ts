// SEC-13: Container-Härtung statisch – die Compose-Dateien, die der Installer auf jedes System legt. Am laufenden Stack prüft
// scripts/haertung-pruefen.sh dasselbe (CI-Jobs „stack“ und „backup“).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

interface Service {
  user?: string;
  read_only?: boolean;
  configs?: unknown[];
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  volumes?: (string | { source?: string })[];
  tmpfs?: string[];
}

function services(file: string): Record<string, Service> {
  return (
    parse(read(file), { merge: true }) as { services: Record<string, Service> }
  ).services;
}

/** Wer root sein darf (mit Begründung im Kommentar „Ausnahme SEC-13“) und welche Capabilities zurückkommen */
const ROOT_OK: Record<string, string[]> = {
  "compose.yaml": ["caddy", "geraete-ca-init", "clamav", "crowdsec"],
  "compose.backup.yaml": ["caddy"],
  "compose.vorschau.yaml": [],
};
const CAPS_OK: Record<string, string[]> = {
  caddy: ["NET_BIND_SERVICE"],
  "geraete-ca-init": ["CHOWN"],
  clamav: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"],
  "step-ca": ["NET_BIND_SERVICE"],
};
/** ohne `user:` – das Image setzt einen Benutzer ohne root-Rechte */
const IMAGE_USER: Record<string, string> = {
  app: "Dockerfile",
  "backup-agent": "apps/agent/Dockerfile",
  backup: "apps/backup/Dockerfile",
};
const IMAGE_USER_UPSTREAM = ["step-ca"]; // smallstep/step-ca läuft als „step“ (uid 1000)

describe("SEC-13: Container-Härtung in den Compose-Dateien", () => {
  for (const file of Object.keys(ROOT_OK)) {
    it(`${file}: read_only, cap_drop ALL, no-new-privileges, kein root ohne Ausnahme, kein docker.sock`, () => {
      const text = read(file);
      for (const [name, s] of Object.entries(services(file))) {
        // read_only nur dort aus, wo Compose „configs“ in den Container kopiert (geht nicht in ein nur lesbares Dateisystem)
        expect(s.read_only, `${file} ${name}: read_only`).toBe(!s.configs?.length);
        expect(s.cap_drop, `${file} ${name}: cap_drop`).toContain("ALL");
        // Ausnahme: step-ca trägt eine Datei-Capability – mit no-new-privileges startet es nicht (begründet in compose.yaml)
        // – ausdrücklich „:false“, keine leere Liste (die lehnt Compose mit einer zweiten -f-Datei ab)
        if (name === "step-ca") {
          expect(text).toContain("Datei-Capability");
          expect(s.security_opt).toEqual(["no-new-privileges:false"]);
        } else
          expect(s.security_opt, `${file} ${name}: security_opt`).toContain(
            "no-new-privileges:true",
          );
        for (const c of s.cap_add ?? [])
          expect(
            CAPS_OK[name] ?? [],
            `${file} ${name}: cap_add ${c}`,
          ).toContain(c);
        const vols = (s.volumes ?? []).map((v) =>
          typeof v === "string" ? v : (v.source ?? ""),
        );
        expect(vols.join(" "), `${file} ${name}: docker.sock`).not.toContain(
          "docker.sock",
        );
        const root =
          s.user === "root" ||
          s.user === "0" ||
          (s.user === undefined &&
            !IMAGE_USER[name] &&
            !IMAGE_USER_UPSTREAM.includes(name));
        if (root) {
          expect(ROOT_OK[file], `${file} ${name}: läuft als root`).toContain(
            name,
          );
          // die Ausnahme ist beim Dienst begründet
          const block = text.slice(
            text.indexOf(`\n  ${name}:\n`),
            text.indexOf("\n\n", text.indexOf(`\n  ${name}:\n`)),
          );
          expect(block, `${file} ${name}: Begründung fehlt`).toContain(
            "Ausnahme SEC-13",
          );
        }
      }
    });
  }

  it("eigene Images laufen als node, nicht als root", () => {
    for (const f of new Set(Object.values(IMAGE_USER)))
      expect(read(f), f).toMatch(/^USER node$/m);
  });

  it("große Arbeitsdateien nicht im Speicher: Backup-Agent und Backup-App mit /tmp als Volume, restic-Cache dort", () => {
    const main = services("compose.yaml");
    expect(main["backup-agent"]!.tmpfs).toEqual([]);
    expect(main["backup-agent"]!.volumes).toContain("agent_tmp:/tmp");
    const backup = services("compose.backup.yaml");
    expect(backup.backup!.tmpfs).toEqual([]);
    expect(backup.backup!.volumes).toContain("backup_tmp:/tmp");
    expect(read("compose.yaml")).toContain("XDG_CACHE_HOME: /tmp/.cache");
    expect(read("compose.backup.yaml")).toContain(
      "XDG_CACHE_HOME: /tmp/.cache",
    );
    // PostgreSQL ohne root: Socket im tmpfs
    expect(main.postgres!.user).toBe("postgres");
    expect(main.postgres!.tmpfs!.join(" ")).toContain("/var/run/postgresql");
    expect(backup["restore-db"]!.user).toBe("postgres");
  });
});
