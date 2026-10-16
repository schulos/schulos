import { describe, expect, it } from "vitest";
import { sha256Hex, validateManifest, type HostFile, type ReleaseManifest } from "@schulos/server/release";
import { replaceCtl, stageCompose, type HostFileDeps } from "./host-files";

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const dec = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("utf8") : undefined);

function fs(initial: Record<string, string>, release: Partial<Record<HostFile, string>>) {
  const files = new Map<string, Uint8Array>(Object.entries(initial).map(([k, v]) => [k, enc(v)]));
  const fetched: string[] = [];
  const d: HostFileDeps = {
    read: (f) => files.get(f) ?? null,
    write: (f, data) => void files.set(f, data),
    rename: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    remove: (f) => void files.delete(f),
    fetch: async (_m, name) => {
      fetched.push(name);
      return release[name] !== undefined ? enc(release[name]!) : null;
    },
  };
  return { d, files, fetched, text: (f: string) => dec(files.get(f)) };
}

const manifest = (files?: Partial<Record<HostFile, string>>) => ({ version: "1.0.1", ...(files ? { files } : {}) }) as unknown as ReleaseManifest;
const hash = (s: string) => sha256Hex(enc(s));

describe("GATE-031 C-01: Manifest mit Host-Dateien", () => {
  it("files nur mit bekannten Namen und SHA-256", () => {
    const base = {
      schema: 1,
      version: "1.0.1",
      minVersion: "1.0.0",
      publishedAt: "2026-10-01T00:00:00Z",
      stableFrom: null,
      securityRelevant: false,
      changes: [{ kind: "neu", text: "Etwas Neues" }],
      images: { app: `ghcr.io/x/a@sha256:${"a".repeat(64)}`, backup: `ghcr.io/x/b@sha256:${"b".repeat(64)}`, agent: `ghcr.io/x/c@sha256:${"c".repeat(64)}` },
      commit: "abcdef1",
    };
    expect(validateManifest({ ...base, files: { "schulosctl.mjs": "1".repeat(64), "compose.yaml": "2".repeat(64) } }).files).toBeDefined();
    expect(() => validateManifest({ ...base, files: { "../etc/passwd": "1".repeat(64) } })).toThrow(/files/);
    expect(() => validateManifest({ ...base, files: { "compose.yaml": "kurz" } })).toThrow(/files/);
    expect(validateManifest(base).files).toBeUndefined();
  });
});

describe("GATE-031 C-01: compose.yaml aus dem Release", () => {
  const opts = (m: ReleaseManifest, known: string[] = [], problem: string | null = null) => ({
    file: "/s/compose.yaml",
    m,
    from: "1.0.0",
    known: new Set(known),
    validate: async () => problem,
  });

  it("ersetzt bei passender Prüfsumme, sichert die alte Fassung, Rückweg legt sie zurück", async () => {
    const f = fs({ "/s/compose.yaml": "alt" }, { "compose.yaml": "neu" });
    const r = await stageCompose(f.d, opts(manifest({ "compose.yaml": hash("neu") }), [hash("alt")]));
    expect(r?.note).toBe("compose.yaml aus 1.0.1 übernommen (vorige Fassung: compose.yaml.vorher-1.0.0)");
    expect(f.text("/s/compose.yaml")).toBe("neu");
    expect(f.text("/s/compose.yaml.vorher-1.0.0")).toBe("alt");
    r!.restore();
    expect(f.text("/s/compose.yaml")).toBe("alt");
  });

  it("falsche Prüfsumme → nichts geändert", async () => {
    const f = fs({ "/s/compose.yaml": "alt" }, { "compose.yaml": "untergeschoben" });
    await expect(stageCompose(f.d, opts(manifest({ "compose.yaml": hash("neu") })))).rejects.toThrow(/Prüfsumme/);
    expect(f.text("/s/compose.yaml")).toBe("alt");
    expect([...f.files.keys()]).toEqual(["/s/compose.yaml"]);
  });

  it("neue Datei passt nicht zur .env → alte bleibt", async () => {
    const f = fs({ "/s/compose.yaml": "alt" }, { "compose.yaml": "neu" });
    await expect(stageCompose(f.d, opts(manifest({ "compose.yaml": hash("neu") }), [], "required variable X is missing"))).rejects.toThrow(/passt nicht zur .env/);
    expect(f.text("/s/compose.yaml")).toBe("alt");
  });

  it("schon aktuell bzw. Release ohne Host-Dateien → nichts holen", async () => {
    const f = fs({ "/s/compose.yaml": "neu" }, { "compose.yaml": "neu" });
    expect(await stageCompose(f.d, opts(manifest({ "compose.yaml": hash("neu") })))).toBeNull();
    expect(await stageCompose(f.d, opts(manifest()))).toBeNull();
    expect(f.fetched).toEqual([]);
  });

  it("von Hand geänderte Datei: trotzdem ersetzt (Release gibt den Stand vor), Hinweis im Protokoll", async () => {
    const f = fs({ "/s/compose.yaml": "lokal geändert" }, { "compose.yaml": "neu" });
    const r = await stageCompose(f.d, opts(manifest({ "compose.yaml": hash("neu") }), [hash("alt")]));
    expect(r?.note).toContain("von Hand geändert");
    expect(f.text("/s/compose.yaml.vorher-1.0.0")).toBe("lokal geändert");
  });
});

describe("GATE-031 C-01: schulosctl ersetzt sich selbst", () => {
  const ok = async () => true;

  it("prüft Prüfsumme und Probestart, sichert die alte Fassung", async () => {
    const f = fs({ "/s/schulosctl.mjs": "ctl-alt" }, { "schulosctl.mjs": "ctl-neu" });
    const started: string[] = [];
    const note = await replaceCtl(f.d, { file: "/s/schulosctl.mjs", m: manifest({ "schulosctl.mjs": hash("ctl-neu") }), smoke: async (x) => (started.push(x), true) });
    expect(note).toContain("schulosctl aus 1.0.1 übernommen");
    expect(started).toEqual(["/s/schulosctl.neu.mjs"]);
    expect(f.text("/s/schulosctl.mjs")).toBe("ctl-neu");
    expect(f.text("/s/schulosctl.mjs.vorher")).toBe("ctl-alt");
  });

  it("Probestart scheitert → alte Fassung bleibt, keine Reste", async () => {
    const f = fs({ "/s/schulosctl.mjs": "ctl-alt" }, { "schulosctl.mjs": "ctl-neu" });
    await expect(replaceCtl(f.d, { file: "/s/schulosctl.mjs", m: manifest({ "schulosctl.mjs": hash("ctl-neu") }), smoke: async () => false })).rejects.toThrow(/startet nicht/);
    expect([...f.files.keys()]).toEqual(["/s/schulosctl.mjs"]);
    expect(f.text("/s/schulosctl.mjs")).toBe("ctl-alt");
  });

  it("falsche Prüfsumme bzw. nicht abrufbar → abgelehnt; ohne installierte Datei (Entwicklung) nichts", async () => {
    const f = fs({ "/s/schulosctl.mjs": "ctl-alt" }, { "schulosctl.mjs": "böse" });
    await expect(replaceCtl(f.d, { file: "/s/schulosctl.mjs", m: manifest({ "schulosctl.mjs": hash("ctl-neu") }), smoke: ok })).rejects.toThrow(/Prüfsumme/);
    const g = fs({ "/s/schulosctl.mjs": "ctl-alt" }, {});
    await expect(replaceCtl(g.d, { file: "/s/schulosctl.mjs", m: manifest({ "schulosctl.mjs": hash("ctl-neu") }), smoke: ok })).rejects.toThrow(/nicht abrufbar/);
    const h = fs({}, { "schulosctl.mjs": "ctl-neu" });
    expect(await replaceCtl(h.d, { file: "/s/schulosctl.mjs", m: manifest({ "schulosctl.mjs": hash("ctl-neu") }), smoke: ok })).toBeNull();
    expect(h.fetched).toEqual([]);
  });
});
