// Auswertung des Lasttests (B-50a, scripts/lasttest.sh): k6-Zusammenfassung, `docker stats` und `vmstat` aus der VM →
// Antwortzeiten je Seite, CPU je Dienst, Engpass. Rein (ohne Dateien), damit testbar; Aufruf über scripts/lasttest-auswertung.ts.

export type PageTiming = { name: string; count: number; avg: number; p95: number; max: number };
export type ContainerLoad = { service: string; avgCpu: number; maxCpu: number; maxMemMb: number };
export type VmLoad = { samples: number; busy: number; maxBusy: number; wait: number; steal: number };
export type Bottleneck = { kind: "node" | "postgres" | "disk" | "cpu" | "none"; text: string };

/** Teilmetriken `http_req_duration{name:<seite>}` aus der k6-Zusammenfassung (handleSummary-Daten bzw. deren JSON). */
export function pageTimings(summary: { metrics?: Record<string, { values?: Record<string, number> }> }): PageTiming[] {
  const out: PageTiming[] = [];
  const metrics = summary.metrics ?? {};
  for (const [key, m] of Object.entries(metrics)) {
    const name = /^http_req_duration\{name:([^}]+)\}$/.exec(key)?.[1];
    if (!name || !m.values) continue;
    const count = metrics[`http_reqs{name:${name}}`]?.values?.count ?? 0;
    out.push({ name, count, avg: m.values.avg ?? 0, p95: m.values["p(95)"] ?? 0, max: m.values.max ?? 0 });
  }
  return out.sort((a, b) => b.p95 - a.p95);
}

/** Dienstname aus dem Containernamen (`schulos-app-1` → `app`). */
export function serviceOf(container: string): string {
  const m = /^[a-z0-9]+[-_](.+?)[-_]\d+$/.exec(container);
  return m?.[1] ?? container;
}

function memMb(usage: string): number {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/.exec(usage.trim());
  if (!m?.[1] || !m[2]) return 0;
  const factor: Record<string, number> = { B: 1 / 2 ** 20, KiB: 1 / 1024, kB: 1 / 1000, MiB: 1, MB: 1, GiB: 1024, GB: 1000, TiB: 2 ** 20, TB: 1e6 };
  return Number(m[1]) * (factor[m[2]] ?? 0);
}

/**
 * Zeilen „<zeit>;<container>;<cpu>%;<speicher> / <grenze>“ (scripts/lasttest.sh, `docker stats --no-stream`) → Last je Dienst.
 * CPU in Prozent **eines** Kerns wie bei docker (200 % = zwei Kerne voll).
 */
export function containerLoads(text: string): ContainerLoad[] {
  const by = new Map<string, { cpu: number[]; mem: number[] }>();
  for (const line of text.split("\n")) {
    const [, name, cpu, mem] = line.trim().split(";");
    if (!name || !cpu) continue;
    const value = Number.parseFloat(cpu.replace("%", ""));
    if (!Number.isFinite(value)) continue;
    const service = serviceOf(name);
    const entry = by.get(service) ?? { cpu: [], mem: [] };
    entry.cpu.push(value);
    entry.mem.push(memMb((mem ?? "").split("/")[0] ?? ""));
    by.set(service, entry);
  }
  return [...by.entries()]
    .map(([service, e]) => ({
      service,
      avgCpu: e.cpu.reduce((s, v) => s + v, 0) / e.cpu.length,
      maxCpu: Math.max(...e.cpu),
      maxMemMb: Math.max(...e.mem),
    }))
    .sort((a, b) => b.avgCpu - a.avgCpu);
}

/** Ausgabe von `vmstat -n 5` → mittlere Auslastung der VM (100 − id), I/O-Wartezeit, Steal. Erste Zeile (seit Start) zählt nicht. */
export function vmLoad(text: string): VmLoad {
  let header: string[] | null = null;
  const rows: number[][] = [];
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.includes("id") && cols.includes("wa")) header = cols;
    else if (header && cols.length === header.length && cols.every((c) => /^\d+$/.test(c))) rows.push(cols.map(Number));
  }
  const data = rows.slice(1);
  if (!header || data.length === 0) return { samples: 0, busy: 0, maxBusy: 0, wait: 0, steal: 0 };
  const col = (n: string) => header!.indexOf(n);
  const avg = (i: number) => (i < 0 ? 0 : data.reduce((s, r) => s + (r[i] ?? 0), 0) / data.length);
  const busy = data.map((r) => 100 - (r[col("id")] ?? 0));
  return {
    samples: data.length,
    busy: busy.reduce((s, v) => s + v, 0) / busy.length,
    maxBusy: Math.max(...busy),
    wait: avg(col("wa")),
    steal: avg(col("st")),
  };
}

/**
 * Engpass grob bestimmen. Node verarbeitet JavaScript in **einem** Prozess – die App kann einen Kern sättigen, während die VM
 * noch Luft hat (dann helfen mehr Kerne erst mit mehreren App-Instanzen, B-52).
 */
export function bottleneck(loads: ContainerLoad[], vm: VmLoad, cores: number): Bottleneck {
  const cpu = (s: string) => loads.find((l) => l.service === s)?.avgCpu ?? 0;
  const app = cpu("app");
  const pg = cpu("postgres");
  if (vm.wait >= 20) return { kind: "disk", text: `Platte: ${vm.wait.toFixed(0)} % I/O-Wartezeit` };
  if (app >= 85 && app / 100 < cores * 0.8) {
    return { kind: "node", text: `Node-Prozess der App: ${app.toFixed(0)} % eines Kerns – die übrigen Kerne bringen erst mit B-52 etwas` };
  }
  if (vm.busy >= 85) {
    return pg > app
      ? { kind: "postgres", text: `CPU der VM voll (${vm.busy.toFixed(0)} %), größter Anteil Postgres (${pg.toFixed(0)} % gegenüber App ${app.toFixed(0)} %)` }
      : { kind: "cpu", text: `CPU der VM voll (${vm.busy.toFixed(0)} %), größter Anteil App (${app.toFixed(0)} %, Postgres ${pg.toFixed(0)} %)` };
  }
  return { kind: "none", text: `kein Engpass erkennbar (VM ${vm.busy.toFixed(0)} % ausgelastet, App ${app.toFixed(0)} %, Postgres ${pg.toFixed(0)} %)` };
}

export type DbTable = { table: string; seqScans: number; seqRows: number; idxScans: number };

/**
 * Tabellen mit vielen sequenziellen Scans während des Laufs (Differenz zweier Abzüge von `pg_stat_user_tables`, Zeilen
 * „tabelle|seq_scan|seq_tup_read|idx_scan“) – Hinweis auf fehlende Indizes bzw. N+1-Abfragen.
 */
export function seqScanHotspots(before: string, after: string, top = 8): DbTable[] {
  const parse = (t: string) =>
    new Map(
      t
        .split("\n")
        .map((l) => l.trim().split("|"))
        .filter((c) => c.length === 4 && c[0])
        .map(([table, s, r, i]) => [table ?? "", { seqScans: Number(s), seqRows: Number(r), idxScans: Number(i || 0) }] as const),
    );
  const a = parse(before);
  const rows: DbTable[] = [];
  for (const [table, b] of parse(after)) {
    const p = a.get(table) ?? { seqScans: 0, seqRows: 0, idxScans: 0 };
    const d = { table, seqScans: b.seqScans - p.seqScans, seqRows: b.seqRows - p.seqRows, idxScans: b.idxScans - p.idxScans };
    if (d.seqScans > 0) rows.push(d);
  }
  return rows.sort((x, y) => y.seqRows - x.seqRows).slice(0, top);
}

export type Statement = { calls: number; totalMs: number; meanMs: number; query: string };

/** Zeilen „aufrufe|gesamt-ms|mittel-ms|abfrage“ aus pg_stat_statements (scripts/lasttest.sh, nach dem Lauf). */
export function topStatements(text: string, maxQuery = 160): Statement[] {
  return text
    .split("\n")
    .map((l) => l.trim().split("|"))
    .filter((c) => c.length >= 4 && /^\d+$/.test(c[0] ?? ""))
    .map(([calls, total, mean, ...q]) => {
      const query = q.join("|").trim();
      return { calls: Number(calls), totalMs: Number(total), meanMs: Number(mean), query: query.length > maxQuery ? `${query.slice(0, maxQuery - 1)}…` : query };
    });
}

export type LoadTestInput = {
  label: string;
  cores: number;
  memoryMb: number;
  users: number;
  pages: PageTiming[];
  failedRate: number;
  requests: number;
  loads: ContainerLoad[];
  vm: VmLoad;
  hotspots: DbTable[];
  statements?: Statement[];
};

const ms = (v: number) => `${Math.round(v)} ms`;

/** Bericht als Markdown (Workflow-Zusammenfassung und Artefakt). */
export function report(r: LoadTestInput): string {
  const b = bottleneck(r.loads, r.vm, r.cores);
  const lines = [
    `## Lasttest ${r.label}: ${r.users} Nutzer, ${r.cores} Kerne, ${(r.memoryMb / 1024).toFixed(0)} GB`,
    "",
    `**Engpass:** ${b.text}`,
    "",
    `${r.requests} Anfragen, Fehlerquote ${(r.failedRate * 100).toFixed(2)} %. VM: ${r.vm.busy.toFixed(0)} % ausgelastet (max. ${r.vm.maxBusy.toFixed(0)} %), I/O-Wartezeit ${r.vm.wait.toFixed(1)} %, Steal ${r.vm.steal.toFixed(1)} %.`,
    "",
    "| Seite | Anfragen | Mittel | p95 | Max |",
    "|---|---:|---:|---:|---:|",
    ...r.pages.map((p) => `| ${p.name} | ${p.count} | ${ms(p.avg)} | ${ms(p.p95)} | ${ms(p.max)} |`),
    "",
    "| Dienst | CPU Mittel | CPU Max | Speicher Max |",
    "|---|---:|---:|---:|",
    ...r.loads.map((l) => `| ${l.service} | ${l.avgCpu.toFixed(0)} % | ${l.maxCpu.toFixed(0)} % | ${Math.round(l.maxMemMb)} MB |`),
  ];
  if (r.hotspots.length > 0) {
    lines.push("", "Sequenzielle Scans während des Laufs (Hinweis auf fehlende Indizes/N+1):", "", "| Tabelle | Seq-Scans | gelesene Zeilen | Index-Scans |", "|---|---:|---:|---:|");
    lines.push(...r.hotspots.map((h) => `| ${h.table} | ${h.seqScans} | ${h.seqRows} | ${h.idxScans} |`));
  }
  if (r.statements?.length) {
    lines.push("", "Abfragen mit der meisten Datenbankzeit (pg_stat_statements):", "", "| Aufrufe | Gesamt | Mittel | Abfrage |", "|---:|---:|---:|---|");
    lines.push(...r.statements.map((s) => `| ${s.calls} | ${ms(s.totalMs)} | ${s.meanMs.toFixed(2)} ms | \`${s.query.replaceAll("|", "\\|")}\` |`));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- Szenario „gemeinsam“ (Gate 3b: 30 Personen in Text/Tafel)

export type Quantiles = { count: number; avg: number; p50: number; p95: number; p99: number; max: number };
export type SharedKind = {
  posts: Quantiles & { failed: number; status: Record<string, number> };
  syncs: Quantiles & { failed: number };
  delivery: Quantiles;
  events: number;
  eventBytes: number;
  sentBytes: number;
  untracked: number;
  maxEditors: number;
  crowded: boolean;
  konsistenz: Record<string, number>;
};
export type SharedPhase = {
  name: string;
  /** Unix-Sekunden – passend zur ersten Spalte von stats.log */
  start: number;
  end: number;
  generator?: { cpuPercent: number; loopDelayP99Ms: number; loopDelayMaxMs: number };
  text?: SharedKind;
  tafel?: SharedKind;
};
export type SharedResult = {
  personen: number;
  dauerMs: number;
  anmeldung: Quantiles & { failed: number };
  sse: { reconnects: number; fehler: string[] };
  phasen: SharedPhase[];
};

/** Grenzwerte (Befund, kein Abbruch): flüssiges Arbeiten zu dritt bis zu dreißigst */
export const SHARED_LIMITS = {
  /** Antwortzeit der Update-POSTs (p95) */
  postP95Ms: 500,
  /** vom Absenden bis die anderen es im SSE-Strom haben (p95) – darüber wirkt das gemeinsame Tippen/Zeichnen hakelig */
  deliveryP95Ms: 1000,
  failedRate: 0.01,
  /** App-Prozess im Mittel höchstens so viel eines Kerns – Rest für alle anderen in der Schule */
  appCpu: 80,
};

/** Zeilen von stats.log im Zeitfenster [from, to] (erste Spalte Unix-Sekunden) */
export function statsBetween(text: string, from: number, to: number): string {
  return text
    .split("\n")
    .filter((l) => {
      const t = Number(l.split(";")[0]);
      return Number.isFinite(t) && t >= from && t <= to;
    })
    .join("\n");
}

export type SharedCheck = { phase: string; kind: string; text: string; ok: boolean };

/** Grenzwerte je Phase und Art prüfen */
export function sharedChecks(result: SharedResult, stats: string): SharedCheck[] {
  const out: SharedCheck[] = [];
  for (const p of result.phasen) {
    for (const kind of ["text", "tafel"] as const) {
      const s = p[kind];
      if (!s) continue;
      const add = (text: string, ok: boolean) => out.push({ phase: p.name, kind, text, ok });
      const rate = s.posts.count ? s.posts.failed / s.posts.count : 0;
      add(`POST p95 ${Math.round(s.posts.p95)} ms (Grenze ${SHARED_LIMITS.postP95Ms} ms)`, s.posts.p95 <= SHARED_LIMITS.postP95Ms);
      add(`Zustellung p95 ${Math.round(s.delivery.p95)} ms (Grenze ${SHARED_LIMITS.deliveryP95Ms} ms)`, s.delivery.count > 0 && s.delivery.p95 <= SHARED_LIMITS.deliveryP95Ms);
      add(`Fehlerquote ${(rate * 100).toFixed(2)} % (Grenze ${SHARED_LIMITS.failedRate * 100} %)`, rate <= SHARED_LIMITS.failedRate);
      const k = s.konsistenz;
      const same = k.gleich === k.personen && (k.serverStaende ?? 1) === 1;
      add(`Konsistenz: ${k.gleich ?? 0} von ${k.personen ?? 0} sehen denselben Stand wie der Server`, same);
    }
    const app = containerLoads(statsBetween(stats, p.start, p.end)).find((l) => l.service === "app");
    if (app) out.push({ phase: p.name, kind: "app", text: `App-CPU im Mittel ${app.avgCpu.toFixed(0)} % eines Kerns (Grenze ${SHARED_LIMITS.appCpu} %)`, ok: app.avgCpu <= SHARED_LIMITS.appCpu });
  }
  return out;
}

const KIND_LABEL = { text: "Text", tafel: "Tafel" } as const;

/** Bericht des Szenarios „gemeinsam“ als Markdown (Workflow-Zusammenfassung und Artefakt) */
export function sharedReport(r: { label: string; cores: number; memoryMb: number; result: SharedResult; stats: string; vm: VmLoad }): string {
  const res = r.result;
  const checks = sharedChecks(res, r.stats);
  const failed = checks.filter((c) => !c.ok);
  const lines = [
    `## Lasttest gemeinsam bearbeiten ${r.label}: ${res.personen} Personen, ${r.cores} Kerne, ${(r.memoryMb / 1024).toFixed(0)} GB`,
    "",
    failed.length === 0
      ? `**Bewertung: reicht** – alle Grenzwerte eingehalten.`
      : `**Bewertung: reicht nicht** – ${failed.map((c) => `${c.phase}/${c.kind}: ${c.text}`).join("; ")}.`,
    "",
    `Anmeldung ${res.anmeldung.count - res.anmeldung.failed}/${res.anmeldung.count} (p95 ${ms(res.anmeldung.p95)}), Live-Strom neu aufgebaut: ${res.sse.reconnects}×. VM: ${r.vm.busy.toFixed(0)} % ausgelastet (max. ${r.vm.maxBusy.toFixed(0)} %).`,
    "",
    "| Phase | Art | POSTs | POST p50 / p95 / p99 | Fehler | Zustellung p50 / p95 / p99 / max | Ereignisse (empfangen) | Anwesend max | Konsistenz |",
    "|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const p of res.phasen) {
    for (const kind of ["text", "tafel"] as const) {
      const s = p[kind];
      if (!s) continue;
      const k = s.konsistenz;
      const extra = kind === "text" ? `${k.zeichen ?? 0} Zeichen` : `${k.sichtbar ?? 0} sichtbare / ${k.elemente ?? 0} Elemente`;
      lines.push(
        `| ${p.name} | ${KIND_LABEL[kind]} | ${s.posts.count} | ${ms(s.posts.p50)} / ${ms(s.posts.p95)} / ${ms(s.posts.p99)} | ${s.posts.failed} | ${ms(s.delivery.p50)} / ${ms(s.delivery.p95)} / ${ms(s.delivery.p99)} / ${ms(s.delivery.max)} | ${s.events} (${(s.eventBytes / 1024 / 1024).toFixed(1)} MB) | ${s.maxEditors}${s.crowded ? " (Hinweis)" : ""} | ${k.gleich ?? 0}/${k.personen ?? 0} gleich, ${k.verpasst ?? 0} mit Lücke, ${extra} |`,
      );
    }
  }
  lines.push("", "| Phase | App CPU Mittel / Max | App Speicher | Postgres CPU Mittel / Max | Caddy CPU Mittel | Lastgenerator |", "|---|---:|---:|---:|---:|---|");
  for (const p of res.phasen) {
    const loads = containerLoads(statsBetween(r.stats, p.start, p.end));
    const l = (s: string) => loads.find((x) => x.service === s);
    const cpu = (s: string) => (l(s) ? `${l(s)!.avgCpu.toFixed(0)} % / ${l(s)!.maxCpu.toFixed(0)} %` : "–");
    const g = p.generator;
    lines.push(
      `| ${p.name} | ${cpu("app")} | ${l("app") ? `${Math.round(l("app")!.maxMemMb)} MB` : "–"} | ${cpu("postgres")} | ${l("caddy") ? `${l("caddy")!.avgCpu.toFixed(0)} %` : "–"} | ${g ? `${g.cpuPercent} % CPU, Event-Loop p99 ${g.loopDelayP99Ms} ms` : "–"} |`,
    );
  }
  lines.push("", "Grenzwerte:", "", ...checks.map((c) => `- ${c.ok ? "eingehalten" : "**überschritten**"} – ${c.phase}/${c.kind}: ${c.text}`));
  const status = new Set(res.phasen.flatMap((p) => [p.text, p.tafel].flatMap((s) => (s ? Object.keys(s.posts.status) : []))));
  if ([...status].some((s) => s !== "200")) {
    lines.push("", "HTTP-Status der POSTs:", "");
    for (const p of res.phasen)
      for (const kind of ["text", "tafel"] as const) {
        const s = p[kind];
        if (s) lines.push(`- ${p.name}/${KIND_LABEL[kind]}: ${Object.entries(s.posts.status).map(([k, v]) => `${k === "0" ? "Netzfehler" : k} ×${v}`).join(", ")}`);
      }
  }
  if (res.sse.fehler.length) lines.push("", `Live-Strom: ${res.sse.fehler.slice(0, 5).join("; ")}`);
  return lines.join("\n") + "\n";
}
