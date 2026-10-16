// Docker auf der Build-VM einstellen (Workflow buildvm.yml): BuildKit-Speicherbereinigung mit Obergrenze für den
// Build-Cache, damit die VM nicht wieder volläuft (2026-10-07, ~26 GB Cache). Übrige Einstellungen bleiben erhalten.
//   sudo node scripts/ci/buildvm-docker.mjs [--grenze 20GB] [--datei /etc/docker/daemon.json]
// Exit 0 + „unverändert“ bzw. „geändert“ auf stdout; der Workflow startet Docker nur bei „geändert“ neu.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { grenze: { type: "string", default: "20GB" }, datei: { type: "string", default: "/etc/docker/daemon.json" } },
});
if (!/^\d+(GB|MB)$/.test(values.grenze)) throw new Error(`--grenze „${values.grenze}“: z. B. 20GB`);

const before = existsSync(values.datei) ? readFileSync(values.datei, "utf8") : "";
const config = before.trim() ? JSON.parse(before) : {};
config.builder = { ...config.builder, gc: { ...config.builder?.gc, enabled: true, defaultKeepStorage: values.grenze } };
const after = JSON.stringify(config, null, 2) + "\n";
if (after === before) {
  console.log("unverändert");
} else {
  writeFileSync(values.datei, after);
  console.log("geändert");
}
