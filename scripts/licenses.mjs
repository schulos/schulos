// Lizenzprüfung der Abhängigkeiten anhand von package-lock.json (kein node_modules nötig).
// SchulOS wird unter AGPL-3.0 veröffentlicht – erlaubt sind nur damit verträgliche Lizenzen.
// Aufruf: node scripts/licenses.mjs [--list]   · Exit 1 bei unbekannter oder nicht erlaubter Lizenz.
import { readFileSync } from "node:fs";

/** Lizenzen, die in das ausgelieferte Image dürfen (SPDX). */
const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Unlicense", "CC0-1.0",
  "MPL-2.0", // Datei-Copyleft, mit AGPL verträglich (MPL §3.3)
  "Zlib", // pako (über Excalidraw, P3-12): freizügig, GPL-verträglich
  "LGPL-3.0-or-later", // sharp/libvips (von Next mitgebracht)
  "CC-BY-4.0", // caniuse-lite: Daten, Namensnennung über den Paketinhalt
  "BlueOak-1.0.0", "Python-2.0", // nur Entwicklungswerkzeuge
]);
/** Nur für Entwicklungswerkzeuge erlaubt – dürfen nicht in die Laufzeit-Abhängigkeiten rutschen. */
const DEV_ONLY = new Set(["BlueOak-1.0.0", "Python-2.0"]);

/**
 * Pakete ohne Lizenzfeld in package.json, deren Lizenzdatei geprüft ist (Name@Version → SPDX). Bei einer neuen Version
 * erneut prüfen – deshalb mit Version.
 */
const VERIFIED = new Map([
  ["fuzzy@0.1.3", "MIT"], // LICENSE-MIT im Paket (über Excalidraw, P3-12)
  ["khroma@2.1.0", "MIT"], // license im Paket (über mermaid ← Excalidraw, P3-12)
]);

/** Prüft einen SPDX-Ausdruck: bei OR genügt eine erlaubte Alternative, bei AND müssen alle erlaubt sein. */
export function licenseAllowed(expr, dev) {
  if (!expr || typeof expr !== "string") return false;
  const clean = expr.replace(/[()]/g, " ").trim();
  return clean.split(/\s+OR\s+/).some((alt) =>
    alt.split(/\s+AND\s+/).every((id) => {
      const l = id.trim();
      return ALLOWED.has(l) && (dev || !DEV_ONLY.has(l));
    }),
  );
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const problems = [];
const counts = new Map();
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/") || pkg.link) continue; // Wurzel, eigene Workspaces bzw. Verweise darauf
  const dev = Boolean(pkg.dev || pkg.devOptional);
  const name = path.replace(/^.*node_modules\//, "");
  const license = typeof pkg.license === "string" ? pkg.license : VERIFIED.get(`${name}@${pkg.version}`);
  counts.set(license ?? "(keine)", (counts.get(license ?? "(keine)") ?? 0) + 1);
  if (!licenseAllowed(license, dev)) {
    problems.push(`${name}@${pkg.version}: ${license ?? "keine Lizenzangabe"}${dev ? " (dev)" : ""}`);
  }
}

if (process.argv.includes("--list")) {
  for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(4)}  ${l}`);
}
if (problems.length) {
  console.error(`Lizenzprüfung: ${problems.length} Paket(e) mit nicht freigegebener Lizenz:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Lizenz prüfen und ggf. in scripts/licenses.mjs freigeben (AGPL-3.0-verträglich?).");
  process.exit(1);
}
console.log(`Lizenzprüfung: ${Object.keys(lock.packages).length - 1} Pakete, alle Lizenzen freigegeben.`);
