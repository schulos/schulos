// Bericht eines Lasttest-Laufs (B-50a) aus den Rohdaten von scripts/lasttest.sh – Logik in @schulos/server/lasttest.
// Läuft mit `npx tsx`:  scripts/lasttest-auswertung.ts <laufordner> <kerne> <ram-mb> <nutzer>  → Markdown auf stdout
// Szenario „gemeinsam“ (Gate 3b): liegt gemeinsam.json im Laufordner, wird dieses ausgewertet statt der k6-Zusammenfassung.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containerLoads, pageTimings, report, seqScanHotspots, sharedReport, topStatements, vmLoad, type SharedResult } from "../packages/server/src/lasttest";

const [dir, cores, memory, users] = process.argv.slice(2);
if (!dir || !cores || !memory || !users) {
  console.error("Aufruf: lasttest-auswertung.ts <laufordner> <kerne> <ram-mb> <nutzer>");
  process.exit(64);
}
const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");

if (existsSync(join(dir, "gemeinsam.json"))) {
  const result = JSON.parse(read("gemeinsam.json")) as SharedResult;
  process.stdout.write(sharedReport({ label: `${cores} Kerne`, cores: Number(cores), memoryMb: Number(memory), result, stats: read("stats.log"), vm: vmLoad(read("vmstat.log")) }) + "\n");
  process.exit(0);
}

const summary = JSON.parse(read("summary.json") || "{}");
const metric = (name: string, value: string) => summary.metrics?.[name]?.values?.[value] ?? 0;

process.stdout.write(
  report({
    label: `${cores} Kerne`,
    cores: Number(cores),
    memoryMb: Number(memory),
    users: Number(users),
    pages: pageTimings(summary),
    failedRate: metric("http_req_failed", "rate"),
    requests: metric("http_reqs", "count"),
    loads: containerLoads(read("stats.log")),
    vm: vmLoad(read("vmstat.log")),
    hotspots: seqScanHotspots(read("tabellen-vorher.txt"), read("tabellen-nachher.txt")),
    statements: topStatements(read("abfragen.txt")),
  }) + "\n",
);
