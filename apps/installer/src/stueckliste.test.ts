import { describe, expect, it } from "vitest";
import { buildStueckliste, parseDpkgQuery, parseImageInspect, parsePackages, sourceDate, STUECKLISTE_FORMAT } from "./stueckliste";

const PACKAGES = `Package: zstd
Version: 1.5.7+dfsg-1
Architecture: amd64
Filename: pool/zstd_1.5.7+dfsg-1_amd64.deb

Package: btrfs-progs
Architecture: amd64
Version: 6.14-1
Description: Checksumming Copy on Write Filesystem utilities

Package: kaputt
`;

describe("Stückliste (B-48)", () => {
  it("Packages-Datei und dpkg-query: Name, Version, Architektur, sortiert; unvollständige Einträge fallen weg", () => {
    expect(parsePackages(PACKAGES)).toEqual([
      { name: "btrfs-progs", version: "6.14-1", arch: "amd64" },
      { name: "zstd", version: "1.5.7+dfsg-1", arch: "amd64" },
    ]);
    expect(parseDpkgQuery("systemd\t257.8-1\tamd64\nadduser\t3.152\tall\n\n")).toEqual([
      { name: "adduser", version: "3.152", arch: "all" },
      { name: "systemd", version: "257.8-1", arch: "amd64" },
    ]);
  });

  it("Images aus docker image inspect – eigene ohne, Fremd-Images mit Registry-Digest; fehlendes Image bricht ab", () => {
    const inspect = JSON.stringify([
      { Id: "sha256:aaa", RepoTags: ["schulos:1.2.0"], RepoDigests: [] },
      { Id: "sha256:bbb", RepoTags: ["postgres:18"], RepoDigests: ["postgres@sha256:ccc"] },
    ]);
    expect(parseImageInspect(inspect, ["schulos:1.2.0", "postgres:18"])).toEqual([
      { ref: "schulos:1.2.0", id: "sha256:aaa", digests: [] },
      { ref: "postgres:18", id: "sha256:bbb", digests: ["postgres@sha256:ccc"] },
    ]);
    expect(() => parseImageInspect(inspect, ["caddy:2"])).toThrow(/caddy:2 fehlt/);
  });

  it("zusammensetzen: Format, Zeit, Pflichtangaben", () => {
    const base = {
      version: "1.2.0",
      commit: "fca91ca",
      node: "24.9.0",
      debian: { quelle: "http://deb.debian.org/debian", zielsystem: [{ name: "zstd", version: "1", arch: "amd64" }] },
      images: [{ ref: "schulos:1.2.0", id: "sha256:aaa", digests: [] }],
    };
    expect(buildStueckliste({ ...base, erstellt: new Date("2026-10-06T12:00:00Z") })).toMatchObject({
      format: STUECKLISTE_FORMAT,
      erstellt: "2026-10-06T12:00:00.000Z",
      commit: "fca91ca",
    });
    expect(() => buildStueckliste({ ...base, commit: "unbekannt" })).toThrow(/Git-Hash/);
    expect(() => buildStueckliste({ ...base, images: [] })).toThrow(/Images/);
  });

  it("Bauzeit aus SOURCE_DATE_EPOCH (B-47)", () => {
    expect(sourceDate("1791288000")?.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(sourceDate(undefined)).toBeUndefined();
    expect(sourceDate("")).toBeUndefined();
    expect(() => sourceDate("gestern")).toThrow(/keine Zahl/);
  });
});
