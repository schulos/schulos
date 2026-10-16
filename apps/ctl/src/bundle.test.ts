import { describe, expect, it } from "vitest";
import { buildManifest } from "@schulos/server/release";
import { bundleImages, bundleInfo, checkImageArchive, loadedDigests } from "./bundle";

const d64 = (c: string) => "sha256:" + c.repeat(64);
const rel = (version: string, app: string) =>
  buildManifest({
    version,
    notes: { changes: [{ kind: "behoben", text: "abc" }] },
    images: { app: `ghcr.io/x/schulos@${d64(app)}`, backup: `ghcr.io/x/schulos-backup@${d64("b")}`, agent: `ghcr.io/x/schulos-agent@${d64("c")}` },
    commit: "abc1234",
    publishedAt: new Date("2026-10-01T00:00:00Z"),
    upstream: { node: `node:24-alpine@${d64("1")}`, caddy: `caddy:2@${d64("2")}`, postgres: `postgres:18@${d64("3")}` },
  });

describe("Offline-Bundle", () => {
  it("sammelt die Laufzeit-Images ohne Doppelte, Basis-Images (node) nicht", () => {
    const imgs = bundleImages([rel("1.4.2", "a"), rel("1.5.0", "e")]);
    expect(imgs.map((i) => i.tag)).toEqual([
      "ghcr.io/x/schulos:1.4.2",
      "ghcr.io/x/schulos-backup:1.4.2",
      "ghcr.io/x/schulos-agent:1.4.2",
      "caddy:2",
      "postgres:18",
      "ghcr.io/x/schulos:1.5.0",
    ]);
    expect(imgs[3]).toEqual({ ref: `caddy:2@${d64("2")}`, digest: d64("2"), tag: "caddy:2" });
    expect(bundleInfo([rel("1.5.0", "e")], new Date("2026-10-05T00:00:00Z"))).toMatchObject({ versions: ["1.5.0"], images: expect.arrayContaining([`postgres:18@${d64("3")}`]) });
  });

  it("liest die geladenen Digests aus docker load", () => {
    const out = `Loaded image ID: ${d64("a")}\nLoaded image: caddy:2@${d64("2")}\n`;
    expect(loadedDigests(out)).toEqual(new Set([d64("a"), d64("2")]));
  });

  // SEC-06: Archiv vor `docker load` prüfen (Formen wie von `docker save` mit containerd-Image-Speicher, Docker 29)
  describe("Prüfung von images.tar vor dem Laden", () => {
    const imgs = bundleImages([rel("1.5.0", "e")]);
    const entry = (digest: string, annotations: Record<string, string> = { "containerd.io/distribution.source.docker.io": "library/caddy" }) => ({
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest,
      size: 9535,
      annotations,
    });
    const index = (...manifests: unknown[]) => JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests });
    const manifest = (...tags: (string[] | null)[]) => JSON.stringify(tags.map((RepoTags) => ({ Config: "blobs/sha256/x", RepoTags, Layers: [] })));

    it("so wie `schulosctl bundle export` speichert (per Digest, ohne Namen): in Ordnung", () => {
      const all = imgs.map((i) => entry(i.digest));
      expect(checkImageArchive({ index: index(...all), manifest: manifest(...all.map(() => null)), repositories: null }, imgs)).toEqual([]);
      // Namen, die der Import ohnehin selbst vergibt, stören nicht
      const named = entry(d64("2"), { "io.containerd.image.name": "docker.io/library/caddy:2", "org.opencontainers.image.ref.name": "2" });
      expect(checkImageArchive({ index: index(named), manifest: manifest(["caddy:2"]), repositories: null }, imgs)).toEqual([]);
    });

    it("zusätzliches Image bzw. fremde Namen (z. B. postgres:17, laufende App-Version) → abgelehnt", () => {
      const extra = entry(d64("9"), { "io.containerd.image.name": "docker.io/library/postgres:17", "org.opencontainers.image.ref.name": "17" });
      const p = checkImageArchive({ index: index(entry(d64("2")), extra), manifest: null, repositories: null }, imgs);
      expect(p.join(" | ")).toMatch(/fremdes Image sha256:9+.*fremder Name docker.io\/library\/postgres:17/);
      // bekannter Digest, aber unter fremdem Namen
      const renamed = entry(d64("3"), { "io.containerd.image.name": "ghcr.io/x/schulos:1.4.2" });
      expect(checkImageArchive({ index: index(renamed), manifest: null, repositories: null }, imgs)).toEqual(["fremder Name ghcr.io/x/schulos:1.4.2"]);
      expect(checkImageArchive({ index: index(entry(d64("3"), { "org.opencontainers.image.ref.name": "18" })), manifest: null, repositories: null }, imgs)).toEqual([
        "Name ohne Bezug 18",
      ]);
      // docker-archive: RepoTags bzw. alte „repositories“-Datei
      expect(checkImageArchive({ index: null, manifest: manifest(["ghcr.io/x/schulos:1.4.2"]), repositories: null }, imgs)).toEqual(["fremder Name ghcr.io/x/schulos:1.4.2"]);
      expect(checkImageArchive({ index: null, manifest: manifest(null), repositories: JSON.stringify({ postgres: { "18": "abc" }, caddy: { "1": "x" } }) }, imgs)).toEqual([
        "fremder Name caddy:1",
      ]);
      expect(checkImageArchive({ index: null, manifest: null, repositories: null }, imgs)).toEqual(["images.tar enthält weder index.json noch manifest.json"]);
      expect(checkImageArchive({ index: "{kaputt", manifest: null, repositories: null }, imgs)).toEqual(["index.json nicht lesbar"]);
    });
  });
});
