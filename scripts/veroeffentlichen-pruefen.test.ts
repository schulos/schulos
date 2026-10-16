import { describe, expect, it } from "vitest";
import { ersetzeNamen, ladePrivateMuster, pruefeDateiname, pruefeText, REGELN } from "./veroeffentlichen-pruefen";

// Persönliche Muster nur als neutrale Platzhalter – die echten stehen nicht im Repo (SCHULOS_PRIVATE_MUSTER bzw. lokale Datei)
const PRIVAT = ladePrivateMuster(
  JSON.stringify({
    regeln: [
      { id: "heimnetz", kategorie: "homelab", stufe: "fehler", muster: "\\b198\\.51\\.100\\.\\d{1,3}\\b", hinweis: "Heimnetz" },
      { id: "hostname", kategorie: "homelab", stufe: "fehler", muster: "\\bmusterhost\\b", flags: "i", hinweis: "Hostname" },
      { id: "name", kategorie: "person", stufe: "fehler", muster: "\\bErikas?\\b", hinweis: "Name" },
      { id: "konto", kategorie: "repo", stufe: "fehler", muster: "\\bErika1970\\b", flags: "i", hinweis: "Konto", ausser: ["(^|/)[^/]+\\.test\\.tsx?$"] },
    ],
    ersetzungen: [
      ["\\b(von|mit|bei) Erika\\b", "g", "$1 der Projektleitung"],
      ["\\b(durch|nur) Erika\\b", "g", "$1 die Projektleitung"],
      ["\\bErikas (\\p{L}[\\p{L}-]*)", "gu", "$1 der Projektleitung"],
      ["\\bErika\\b", "g", "Projektleitung"],
    ],
  }),
  "umgebung",
);
const REGELN_MIT_PRIVAT = [...REGELN, ...PRIVAT.regeln];
const ids = (datei: string, text: string) => pruefeText(datei, text, REGELN_MIT_PRIVAT).map((f) => `${f.regel.id}:${f.regel.stufe}:${f.zeile}`);

describe("Veröffentlichungsprüfung (REPO-01)", () => {
  it("findet Homelab-Details, Namen und Marken – mit Zeilennummer", () => {
    const text = ["# Build-VM", "Runner auf musterhost", "DHCP 198.51.100.58", "Entscheidung Erika 2026-10-13", "wie IServ", "kein Untis-Import"].join("\n");
    expect(ids("docs/x.md", text)).toEqual(["marke:fehler:5", "marke:fehler:6", "heimnetz:fehler:3", "hostname:fehler:2", "name:fehler:4"]);
  });

  it("öffentliche Liste allein enthält keine persönlichen Angaben – nur allgemeine Regeln", () => {
    expect(REGELN.map((r) => r.kategorie)).not.toContain("person");
    expect(pruefeText("docs/x.md", "Runner auf musterhost, Entscheidung Erika")).toEqual([]);
  });

  it("lässt Beispieladressen, Platzhalter und neutrale Begriffe in Ruhe", () => {
    const text = [
      "Schulnetz 192.168.10.0/24, Proxy 10.0.0.1",
      "Offsite z. B. u123456.your-storagebox.de (Hetzner Storage Box)",
      "Projektleitung 2026-10-13; Timeout 30 s; Optimum",
      "Bind-Mounts von D:\\ hängen",
    ].join("\n");
    expect(ids("docs/x.md", text)).toEqual([]);
  });

  it("Geheimnisse: Token, private Schlüssel, Werte in .env-Dateien – Testdaten ausgenommen", () => {
    expect(ids("src/a.ts", `const t = "ghp_${"a".repeat(36)}";`)).toEqual(["github-token:fehler:1"]);
    expect(ids("src/a.ts", "-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["privater-schluessel:fehler:1"]);
    expect(ids("src/a.test.ts", "-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual([]);
    expect(ids(".env.example", "POSTGRES_PASSWORD=bitte-langes-passwort\n# SMTP_PASSWORD=…\nAPI_TOKEN=")).toEqual([]);
    expect(ids(".env.example", "POSTGRES_PASSWORD=Sommer2026!")).toEqual(["env-wert:fehler:1"]);
    expect(ids("src/a.ts", "POSTGRES_PASSWORD=Sommer2026!")).toEqual([]);
    expect(pruefeDateiname("deploy/.env").map((f) => f.regel.id)).toEqual(["geheime-datei"]);
    expect(pruefeDateiname("cosign.key").map((f) => f.regel.id)).toEqual(["geheime-datei"]);
    expect(pruefeDateiname(".env.example")).toEqual([]);
  });

  it("Ausnahmen je Pfad (auch aus den persönlichen Mustern), Landesplattformen nur als Hinweis", () => {
    expect(ids("package.json", '"url": "git+https://github.com/Erika1970/x.git"')).toEqual(["konto:fehler:1"]);
    expect(ids("src/x.test.ts", "ghcr.io/erika1970/schulos:1.0.0")).toEqual([]);
    expect(ids("docs/DATENSCHUTZ.md", "mit LOGINEO NRW")).toEqual(["landesloesung:hinweis:1"]);
    expect(ids("packages/server/src/passwort.ts", '"schulos", "iserv",')).toEqual([]);
  });

  it("ersetzt Namen mit passendem Artikel (Regeln aus den persönlichen Mustern)", () => {
    expect(ersetzeNamen("(Erika 2026-10-13) · von Erika · durch Erika · nur Erika; Erikas Vorgabe", PRIVAT.ersetzungen)).toBe(
      "(Projektleitung 2026-10-13) · von der Projektleitung · durch die Projektleitung · nur die Projektleitung; Vorgabe der Projektleitung",
    );
  });

  it("ohne persönliche Muster: keine Regeln, Quelle „keine“", () => {
    expect(ladePrivateMuster(undefined, "datei")).toEqual({ regeln: [], ersetzungen: [], quelle: "keine" });
    expect(ladePrivateMuster("  ", "umgebung").quelle).toBe("keine");
  });
});
