// REPO-01: Prüfung vor der Veröffentlichung – wiederholbar, ohne Netz. Läuft über alle Dateien, die Git kennt bzw. kennen
// würde (versioniert + neu, ohne .gitignore), und meldet Fundstellen nach Stufe:
//   fehler     Geheimnisse, Homelab-Details (Adressen, Hostnamen, VM-Nummern, persönliche Pfade), Personennamen,
//              Fremdproduktnamen als Markenbezug → Exit 1
//   umschalten Stellen, die erst am Umschalt-Tag ersetzt werden (Repo-/Registry-Name) → nur Hinweis, mit --umschalttag Exit 1
//   hinweis    sachliche Nennungen, die bewusst bleiben (z. B. Landesplattformen, Austauschformate) → nur Hinweis
// Aufruf:  npx tsx scripts/veroeffentlichen-pruefen.ts [--umschalttag] [--ersetzen] [--gitleaks] [--still]
//   --ersetzen  Personennamen mechanisch neutralisieren (→ „Projektleitung“; Regeln aus den persönlichen Mustern) –
//               für Nachzügler aus parallelen Zweigen; danach Diff durchsehen
//   --gitleaks  zusätzlich gitleaks über den Arbeitsstand (Binary im PATH, sonst Docker; ohne beides nur ein Hinweis –
//               die ganze Historie prüft der Workflow „Sicherheit“)
// Checkliste für den Umschalt-Tag: docs/VEROEFFENTLICHUNG.md.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Stufe = "fehler" | "umschalten" | "hinweis";
export type Kategorie = "geheimnis" | "homelab" | "person" | "marke" | "repo" | "sachlich";

export interface Regel {
  id: string;
  kategorie: Kategorie;
  stufe: Stufe;
  muster: RegExp;
  hinweis: string;
  /** Pfade (Regex), in denen die Regel nicht gilt – nur Testdaten oder sachlich begründete Stellen */
  ausser?: RegExp[];
}

const TESTDATEI = /(^|\/)[^/]+\.test\.tsx?$/;

/** Die Muster-Liste. Neue Funde: Regel ergänzen statt einzeln zu bereinigen, damit sie nicht wiederkommen. */
export const REGELN: Regel[] = [
  // --- Geheimnisse (ergänzt gitleaks; Ausnahmen wie in .gitleaks.toml nur für Testdaten) ---
  {
    id: "privater-schluessel",
    kategorie: "geheimnis",
    stufe: "fehler",
    muster: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |ENCRYPTED SIGSTORE |ENCRYPTED COSIGN )?PRIVATE KEY-----/,
    hinweis: "privater Schlüssel im Repo",
    ausser: [TESTDATEI, /^packages\/server\/test-fixtures\//],
  },
  { id: "github-token", kategorie: "geheimnis", stufe: "fehler", muster: /\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, hinweis: "GitHub-Token" },
  { id: "aws-schluessel", kategorie: "geheimnis", stufe: "fehler", muster: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/, hinweis: "AWS-Zugangsschlüssel" },
  { id: "slack-token", kategorie: "geheimnis", stufe: "fehler", muster: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, hinweis: "Slack-Token" },
  { id: "api-schluessel", kategorie: "geheimnis", stufe: "fehler", muster: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[A-Za-z0-9_-]{20}\b/, hinweis: "API-Schlüssel (KI-/Cloud-Dienst)" },
  {
    id: "jwt",
    kategorie: "geheimnis",
    stufe: "fehler",
    muster: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    hinweis: "signiertes Token (JWT)",
    ausser: [TESTDATEI],
  },
  { id: "webhook", kategorie: "geheimnis", stufe: "fehler", muster: /discord(?:app)?\.com\/api\/webhooks\/\d+|hooks\.slack\.com\/services\/T/, hinweis: "Webhook-Adresse" },
  {
    id: "env-wert",
    kategorie: "geheimnis",
    stufe: "fehler",
    // Werte in .env-artigen Dateien: nur Platzhalter („bitte-…“, „…“, leer, Variablen) sind erlaubt
    muster: /^\s*#?\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)[A-Z0-9_]*=(?!\s*$|bitte|…|<|\$|ci-)\S{6,}/m,
    hinweis: "Wert für ein Geheimnis in einer Konfigurationsdatei (nur Platzhalter erlaubt)",
  },
  // --- Homelab-Details (allgemein; Adressen, Hostnamen und Dienste der Projektleitung stehen in den persönlichen Mustern) ---
  { id: "storage-box", kategorie: "homelab", stufe: "fehler", muster: /\bu(?!123456\b)\d{6}\b(?:\.your-storagebox\.de)?/, hinweis: "Kennung einer Storage Box (Platzhalter u123456 nehmen)" },
  {
    id: "lokaler-pfad",
    kategorie: "homelab",
    stufe: "fehler",
    muster: /\b[A-Z]:\\Users\\|\\AppData\\|\b[A-Z]:\/Users\//,
    hinweis: "persönlicher Pfad auf einem Rechner",
  },
  // --- Personen: nur in den persönlichen Mustern (Namen gehören nicht in die öffentliche Liste) ---
  // --- Fremdproduktnamen (Marken; Funktionen und allgemeine Begriffe sind frei, PLAN §2) ---
  {
    id: "marke",
    kategorie: "marke",
    stufe: "fehler",
    muster: /\bIServ\b|\b(?:Web)?Untis\b|\bSchulmanager\b|\bitslearning\b|\bMoodle\b|\bSdui\b|\bSchoolFox\b|\bWebWeaver\b|\bLernSax\b|\bschul\.cloud\b|\bMicrosoft Teams\b|\bGoogle Classroom\b|\bEdupage\b/i,
    hinweis: "Fremdproduktname als Markenbezug – Funktion beschreiben statt Produkt nennen",
    // Liste schwacher Passwörter: der Name ist dort ein Passwort-Kandidat, kein Bezug auf das Produkt
    ausser: [/^packages\/server\/src\/passwort\.ts$/],
  },
  {
    id: "landesloesung",
    kategorie: "sachlich",
    stufe: "hinweis",
    muster: /\bLOGINEO\b|\bSchILD\b/,
    hinweis: "Landesplattform/Austauschformat – sachlich genannt (Rechtslage, Import), bleibt",
  },
];

/** Dateien, die die Prüfung nicht liest: fremde Texte (Lizenzen, Lockfile), Binärformate, die Muster-Liste selbst. */
const UEBERSPRINGEN = [
  /^LICENSE$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)tsconfig\.tsbuildinfo$/,
  /^scripts\/veroeffentlichen-pruefen(\.test)?\.ts$/,
  /^scripts\/veroeffentlichen-muster\.local\.json$/,
  /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tar|iso|qcow2|wasm)$/i,
];

export interface Fund {
  datei: string;
  zeile: number;
  regel: Regel;
  text: string;
}

export function pruefeDateiname(datei: string): Fund[] {
  if (/(^|\/)\.env$|(^|\/)(?:cosign|id_[a-z0-9]+)\.key$|\.(?:p12|pfx|kdbx)$/i.test(datei)) {
    return [{ datei, zeile: 0, text: datei, regel: { id: "geheime-datei", kategorie: "geheimnis", stufe: "fehler", muster: /$^/, hinweis: "Datei mit Geheimnissen im Repo" } }];
  }
  return [];
}

export function pruefeText(datei: string, text: string, regeln: Regel[] = REGELN): Fund[] {
  const funde: Fund[] = [];
  const zeilen = text.split(/\r?\n/);
  for (const regel of regeln) {
    if (regel.ausser?.some((r) => r.test(datei))) continue;
    if (regel.id === "env-wert" && !/(^|\/)\.env|\.env(\.[a-z]+)?$|env\.example$/.test(datei)) continue;
    const zeilenMuster = new RegExp(regel.muster.source, regel.muster.flags.replace(/[gm]/g, ""));
    zeilen.forEach((z, i) => {
      if (zeilenMuster.test(z)) funde.push({ datei, zeile: i + 1, regel, text: z.trim().slice(0, 160) });
    });
  }
  return funde;
}

/** Namensersetzung (--ersetzen) – die Regeln kommen aus den persönlichen Mustern („ersetzungen“: [Muster, Flags, Ersatz]). */
export function ersetzeNamen(text: string, ersetzungen: [RegExp, string][]): string {
  return ersetzungen.reduce((t, [re, ersatz]) => t.replace(re, ersatz), text);
}

/**
 * Persönliche Muster (Name, Mail-Domain, Heimnetz, Hostnamen, private Dienste, Kontoname) stehen bewusst nicht im Repo –
 * sonst veröffentlichte die Prüfung genau das, was sie fernhalten soll. Quelle: Umgebungsvariable SCHULOS_PRIVATE_MUSTER
 * (CI: Secret VEROEFFENTLICHUNG_MUSTER) bzw. die nicht versionierte Datei PRIVAT_DATEI.
 * Format: { "regeln": [{ id, kategorie, stufe, muster, flags?, hinweis, ausser?: [Regex] }], "ersetzungen": [[Muster, Flags, Ersatz]] }
 */
export const PRIVAT_DATEI = "scripts/veroeffentlichen-muster.local.json";

export interface PrivateMuster {
  regeln: Regel[];
  ersetzungen: [RegExp, string][];
  quelle: "umgebung" | "datei" | "keine";
}

interface RoheMuster {
  regeln?: { id: string; kategorie: Kategorie; stufe: Stufe; muster: string; flags?: string; hinweis: string; ausser?: string[] }[];
  ersetzungen?: [string, string, string][];
}

export function ladePrivateMuster(json: string | undefined, quelle: PrivateMuster["quelle"]): PrivateMuster {
  if (!json?.trim()) return { regeln: [], ersetzungen: [], quelle: "keine" };
  const roh = JSON.parse(json) as RoheMuster;
  return {
    regeln: (roh.regeln ?? []).map((r) => ({
      id: r.id,
      kategorie: r.kategorie,
      stufe: r.stufe,
      muster: new RegExp(r.muster, r.flags ?? ""),
      hinweis: r.hinweis,
      ausser: r.ausser?.map((a) => new RegExp(a)),
    })),
    ersetzungen: (roh.ersetzungen ?? []).map(([m, f, e]) => [new RegExp(m, f), e]),
    quelle,
  };
}

function privateMuster(): PrivateMuster {
  if (process.env.SCHULOS_PRIVATE_MUSTER) return ladePrivateMuster(process.env.SCHULOS_PRIVATE_MUSTER, "umgebung");
  let datei: string;
  try {
    datei = readFileSync(PRIVAT_DATEI, "utf8");
  } catch {
    return ladePrivateMuster(undefined, "keine");
  }
  return ladePrivateMuster(datei, "datei");
}

function dateien(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

function lies(datei: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(datei);
  } catch {
    return null; // gelöscht, aber noch im Index
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

function gitleaks(): "ok" | "fund" | "fehlt" {
  const opts = { stdio: "inherit" as const };
  const bin = spawnSync("gitleaks", ["dir", ".", "--redact", "--no-banner", "--config", ".gitleaks.toml"], opts);
  if (!bin.error) return bin.status === 0 ? "ok" : "fund";
  const docker = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${process.cwd()}:/repo:ro`, "ghcr.io/gitleaks/gitleaks:v8.28.0", "dir", "/repo", "--redact", "--no-banner", "--config", "/repo/.gitleaks.toml"],
    opts,
  );
  if (!docker.error && docker.status !== 125) return docker.status === 0 ? "ok" : "fund";
  return "fehlt";
}

function main(argv: string[]): number {
  const umschalttag = argv.includes("--umschalttag");
  const still = argv.includes("--still");
  const privat = privateMuster();
  const regeln = [...REGELN, ...privat.regeln];
  if (argv.includes("--ersetzen")) {
    let n = 0;
    for (const d of dateien()) {
      if (UEBERSPRINGEN.some((r) => r.test(d))) continue;
      const t = lies(d);
      if (t === null) continue;
      const neu = ersetzeNamen(t, privat.ersetzungen);
      if (neu !== t) {
        writeFileSync(d, neu);
        n++;
        console.log(`ersetzt: ${d}`);
      }
    }
    console.log(`${n} Dateien geändert – Diff durchsehen (Grammatik), dann erneut prüfen.`);
  }
  const funde: Fund[] = [];
  for (const d of dateien()) {
    funde.push(...pruefeDateiname(d));
    if (UEBERSPRINGEN.some((r) => r.test(d))) continue;
    const t = lies(d);
    if (t !== null) funde.push(...pruefeText(d, t, regeln));
  }
  const zaehlt = (f: Fund) => f.regel.stufe === "fehler" || (umschalttag && f.regel.stufe === "umschalten");
  const reihenfolge: Stufe[] = ["fehler", "umschalten", "hinweis"];
  for (const stufe of reihenfolge) {
    const liste = funde.filter((f) => f.regel.stufe === stufe);
    if (!liste.length || (still && stufe === "hinweis")) continue;
    console.log(`\n== ${stufe} (${liste.length})`);
    for (const f of liste) console.log(`${f.datei}:${f.zeile}  [${f.regel.id}] ${f.regel.hinweis}\n    ${f.text}`);
  }
  let rot = funde.some(zaehlt);
  if (argv.includes("--gitleaks")) {
    const g = gitleaks();
    if (g === "fehlt") console.log("\nHinweis: gitleaks weder im PATH noch per Docker – die Historie prüft der Workflow „Sicherheit“ (gh workflow run security.yml).");
    if (g === "fund") rot = true;
  }
  // Inhalt der persönlichen Muster nie ausgeben (CI-Logs sind öffentlich) – nur, ob es sie gab
  if (privat.quelle === "keine") console.log(`
Hinweis: ohne persönliche Muster geprüft (weder SCHULOS_PRIVATE_MUSTER noch ${PRIVAT_DATEI}).`);
  else console.log(`
Persönliche Muster: ${privat.regeln.length} Regeln (${privat.quelle}).`);
  const zahl = (s: Stufe) => funde.filter((f) => f.regel.stufe === s).length;
  console.log(`\nVeröffentlichungsprüfung: ${zahl("fehler")} Fehler, ${zahl("umschalten")} für den Umschalt-Tag, ${zahl("hinweis")} Hinweise → ${rot ? "NICHT bereit" : "bereit"}${umschalttag ? " (Umschalt-Tag)" : ""}`);
  return rot ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
