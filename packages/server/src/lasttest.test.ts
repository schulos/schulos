import { describe, expect, it } from "vitest";
import { bottleneck, containerLoads, pageTimings, report, seqScanHotspots, serviceOf, sharedChecks, sharedReport, statsBetween, topStatements, vmLoad, type SharedKind, type SharedResult } from "./lasttest";

const VMSTAT = `procs -----------memory---------- ---swap-- -----io---- -system-- -------cpu-------
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu
 1  0      0 812000  21000 900000    0    0   120    40  300  500  5  2 92  1  0  0
 3  0      0 800000  21000 900100    0    0     0    80 2000 4000 60 10 26  4  0  0
 4  1      0 790000  21000 900200    0    0     0   120 2500 4500 70 12 10  8  0  0
`;

describe("Lasttest-Auswertung (B-50a)", () => {
  it("liest Antwortzeiten je Seite aus der k6-Zusammenfassung, langsamste zuerst", () => {
    const pages = pageTimings({
      metrics: {
        http_req_duration: { values: { avg: 100, "p(95)": 300 } },
        "http_req_duration{name:heute}": { values: { avg: 120, "p(95)": 400, max: 900 } },
        "http_req_duration{name:anmeldung}": { values: { avg: 300, "p(95)": 800, max: 1500 } },
        "http_reqs{name:heute}": { values: { count: 1200 } },
      },
    });
    expect(pages.map((p) => p.name)).toEqual(["anmeldung", "heute"]);
    expect(pages[1]).toEqual({ name: "heute", count: 1200, avg: 120, p95: 400, max: 900 });
    expect(pages[0]?.count).toBe(0);
  });

  it("ordnet Container Diensten zu und mittelt CPU/Speicher", () => {
    expect(serviceOf("schulos-app-1")).toBe("app");
    expect(serviceOf("schulos_backup-agent_1")).toBe("backup-agent");
    expect(serviceOf("fremd")).toBe("fremd");
    const loads = containerLoads(
      [
        "10:00:00;schulos-app-1;95.5%;400MiB / 7.7GiB",
        "10:00:05;schulos-app-1;104.5%;512MiB / 7.7GiB",
        "10:00:00;schulos-postgres-1;20%;1.5GiB / 7.7GiB",
        "kaputt",
        "10:00:05;schulos-caddy-1;--;0B / 0B",
      ].join("\n"),
    );
    expect(loads).toEqual([
      { service: "app", avgCpu: 100, maxCpu: 104.5, maxMemMb: 512 },
      { service: "postgres", avgCpu: 20, maxCpu: 20, maxMemMb: 1536 },
    ]);
  });

  it("mittelt vmstat ohne die erste Zeile (Mittel seit dem Start)", () => {
    const vm = vmLoad(VMSTAT);
    expect(vm.samples).toBe(2);
    expect(vm.busy).toBe(82);
    expect(vm.maxBusy).toBe(90);
    expect(vm.wait).toBe(6);
    expect(vmLoad("nichts").samples).toBe(0);
  });

  it("erkennt den Engpass: Platte, ein Node-Kern, CPU der VM, keiner", () => {
    const vm = { samples: 10, busy: 50, maxBusy: 60, wait: 2, steal: 0 };
    const loads = (app: number, pg: number) => [
      { service: "app", avgCpu: app, maxCpu: app, maxMemMb: 0 },
      { service: "postgres", avgCpu: pg, maxCpu: pg, maxMemMb: 0 },
    ];
    expect(bottleneck(loads(30, 10), { ...vm, wait: 25 }, 4).kind).toBe("disk");
    expect(bottleneck(loads(98, 30), vm, 4).kind).toBe("node");
    // bei einem Kern ist die volle App kein Sonderfall „ein Kern“, sondern die VM ist voll
    expect(bottleneck(loads(90, 8), { ...vm, busy: 95 }, 1).kind).toBe("cpu");
    expect(bottleneck(loads(60, 120), { ...vm, busy: 92 }, 2).kind).toBe("postgres");
    expect(bottleneck(loads(40, 10), vm, 4).kind).toBe("none");
  });

  it("findet Tabellen mit vielen sequenziellen Scans aus zwei Abzügen", () => {
    const before = "users|10|1000|50\nnews_posts|0|0|0\n";
    const after = "users|510|316000|90\nnews_posts|2|40|7\nneu|1|5|\n";
    expect(seqScanHotspots(before, after)).toEqual([
      { table: "users", seqScans: 500, seqRows: 315000, idxScans: 40 },
      { table: "news_posts", seqScans: 2, seqRows: 40, idxScans: 7 },
      { table: "neu", seqScans: 1, seqRows: 5, idxScans: 0 },
    ]);
  });

  it("liest die teuersten Abfragen aus pg_stat_statements (auch mit | in der Abfrage)", () => {
    const st = topStatements("4200|1234.5|0.29|select * from users where id = $1\nkaputt\n10|5|0.5|select a || b from x\n", 20);
    expect(st).toEqual([
      { calls: 4200, totalMs: 1234.5, meanMs: 0.29, query: "select * from users…" },
      { calls: 10, totalMs: 5, meanMs: 0.5, query: "select a || b from x" },
    ]);
    expect(topStatements("")).toEqual([]);
  });

  it("schreibt einen Bericht mit Engpass und Tabellen", () => {
    const md = report({
      label: "2 Kerne",
      cores: 2,
      memoryMb: 4096,
      users: 300,
      pages: [{ name: "heute", count: 10, avg: 100.4, p95: 250.6, max: 900 }],
      failedRate: 0.001,
      requests: 5000,
      loads: [{ service: "app", avgCpu: 99, maxCpu: 120, maxMemMb: 512.4 }],
      vm: { samples: 3, busy: 60, maxBusy: 70, wait: 1, steal: 0 },
      hotspots: [{ table: "users", seqScans: 5, seqRows: 3000, idxScans: 1 }],
      statements: [{ calls: 7, totalMs: 12.4, meanMs: 1.77, query: "select a || b" }],
    });
    expect(md).toContain("300 Nutzer, 2 Kerne, 4 GB");
    expect(md).toContain("**Engpass:** Node-Prozess");
    expect(md).toContain("| heute | 10 | 100 ms | 251 ms | 900 ms |");
    expect(md).toContain("| app | 99 % | 120 % | 512 MB |");
    expect(md).toContain("| users | 5 | 3000 | 1 |");
    expect(md).toContain("| 7 | 12 ms | 1.77 ms | `select a \\|\\| b` |");
    expect(md).toContain("Fehlerquote 0.10 %");
  });
});

describe("Lasttest gemeinsam bearbeiten (Gate 3b)", () => {
  const q = (p95: number, count = 1000) => ({ count, avg: p95 / 2, p50: p95 / 2, p95, p99: p95 * 1.5, max: p95 * 3 });
  const kind = (over: Partial<SharedKind> = {}): SharedKind => ({
    posts: { ...q(80), failed: 0, status: { "200": 1000 } },
    syncs: { ...q(40, 60), failed: 0 },
    delivery: q(120, 29000),
    events: 29000,
    eventBytes: 5 * 1024 * 1024,
    sentBytes: 1024 * 1024,
    untracked: 3,
    maxEditors: 30,
    crowded: false,
    konsistenz: { personen: 30, gleich: 30, verpasst: 0, zeichen: 12000 },
    ...over,
  });
  const stats = ["99;schulos-app-1;40%;300MiB / 4GiB", "100;schulos-app-1;50%;310MiB / 4GiB", "160;schulos-app-1;70%;320MiB / 4GiB", "400;schulos-app-1;190%;320MiB / 4GiB", "120;schulos-postgres-1;10%;100MiB / 4GiB"].join("\n");
  const result = (text: SharedKind, tafel?: SharedKind): SharedResult => ({
    personen: 30,
    dauerMs: 300_000,
    anmeldung: { ...q(900, 30), failed: 0 },
    sse: { reconnects: 0, fehler: [] },
    phasen: [
      { name: "text", start: 100, end: 200, text, generator: { cpuPercent: 35, loopDelayP99Ms: 12, loopDelayMaxMs: 40 } },
      ...(tafel ? [{ name: "tafel", start: 300, end: 420, tafel }] : []),
    ],
  });
  const vm = vmLoad(VMSTAT);

  it("teilt stats.log nach Zeitfenster (Unix-Sekunden)", () => {
    expect(statsBetween(stats, 100, 200).split("\n")).toHaveLength(3);
    expect(containerLoads(statsBetween(stats, 100, 200)).find((l) => l.service === "app")?.avgCpu).toBeCloseTo(60);
  });

  it("alle Grenzwerte eingehalten → reicht", () => {
    const checks = sharedChecks(result(kind()), stats);
    expect(checks.every((c) => c.ok)).toBe(true);
    const md = sharedReport({ label: "2 Kerne", cores: 2, memoryMb: 4096, result: result(kind()), stats, vm });
    expect(md).toContain("**Bewertung: reicht**");
    expect(md).toContain("| text | Text | 1000 | 40 ms / 80 ms / 120 ms | 0 | 60 ms / 120 ms / 180 ms / 360 ms |");
    expect(md).toContain("30/30 gleich, 0 mit Lücke, 12000 Zeichen");
    expect(md).toContain("35 % CPU, Event-Loop p99 12 ms");
  });

  it("langsame Zustellung, Fehler, abweichende Stände und volle App-CPU sind Befunde", () => {
    const slow = kind({ delivery: q(2500), posts: { ...q(700), failed: 30, status: { "200": 970, "429": 30 } } });
    const split = kind({ konsistenz: { personen: 30, gleich: 28, serverStaende: 1, verpasst: 4, elemente: 400, sichtbar: 300 } });
    const checks = sharedChecks(result(slow, split), stats);
    const bad = checks.filter((c) => !c.ok).map((c) => `${c.phase}/${c.kind}: ${c.text}`);
    expect(bad).toEqual([
      "text/text: POST p95 700 ms (Grenze 500 ms)",
      "text/text: Zustellung p95 2500 ms (Grenze 1000 ms)",
      "text/text: Fehlerquote 3.00 % (Grenze 1 %)",
      "tafel/tafel: Konsistenz: 28 von 30 sehen denselben Stand wie der Server",
      "tafel/app: App-CPU im Mittel 190 % eines Kerns (Grenze 80 %)",
    ]);
    const md = sharedReport({ label: "2 Kerne", cores: 2, memoryMb: 4096, result: result(slow, split), stats, vm });
    expect(md).toContain("**Bewertung: reicht nicht**");
    expect(md).toContain("- text/Text: 200 ×970, 429 ×30");
    expect(md).toContain("300 sichtbare / 400 Elemente");
  });

  it("ohne gemessene Zustellung kein „eingehalten“", () => {
    const none = kind({ delivery: q(0, 0) });
    expect(sharedChecks(result(none), stats).find((c) => c.text.startsWith("Zustellung"))?.ok).toBe(false);
  });
});
