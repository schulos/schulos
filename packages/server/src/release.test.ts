import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  archiveDigest,
  autoPatchNotes,
  changedUpstream,
  pinImagesEnv,
  isoImages,
  profileImageEnv,
  latestFinal,
  nextPatch,
  upstreamRefs,
  parsePins,
  pinUpstream,
  UPSTREAM_PINS_FILE,
  buildManifest,
  channelOf,
  compareVersions,
  loadSignedManifest,
  parseVersion,
  planUpdate,
  releaseNotesMarkdown,
  updateKind,
  validateManifest,
  validateNotes,
  verifyManifestSignature,
  visibleIn,
  type ReleaseManifest,
} from "./release";

const digest = (c: string) => "sha256:" + c.repeat(64);
const images = {
  app: `ghcr.io/timow1989/schulos@${digest("a")}`,
  backup: `ghcr.io/timow1989/schulos-backup@${digest("b")}`,
  agent: `ghcr.io/timow1989/schulos-agent@${digest("c")}`,
};
const published = new Date("2026-10-05T10:00:00Z");

function release(version: string, extra: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    ...buildManifest({
      version,
      notes: { changes: [{ kind: "behoben", text: "Kleinigkeiten behoben" }] },
      images,
      commit: "abc1234",
      publishedAt: published,
    }),
    ...extra,
  };
}

describe("Versionsnummern (SemVer)", () => {
  it("liest und vergleicht", () => {
    expect(parseVersion("v1.4.2")).toEqual({ major: 1, minor: 4, patch: 2, prerelease: [] });
    expect(parseVersion("1.5.0-rc.1").prerelease).toEqual(["rc", 1]);
    expect(() => parseVersion("1.4")).toThrow("Keine gültige Versionsnummer");
    expect(() => parseVersion("01.0.0")).toThrow();
    const sorted = ["1.10.0", "1.2.0", "1.2.0-rc.2", "1.2.0-rc.10", "1.2.0-beta", "0.9.9", "1.2.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.9", "1.2.0-beta", "1.2.0-rc.2", "1.2.0-rc.10", "1.2.0", "1.2.1", "1.10.0"]);
    expect(compareVersions("1.2.0", "v1.2.0")).toBe(0);
  });

  it("Sprungart", () => {
    expect(updateKind("1.4.2", "1.4.3")).toBe("patch");
    expect(updateKind("1.4.2", "1.5.0")).toBe("minor");
    expect(updateKind("1.4.2", "2.0.0")).toBe("major");
  });
});

describe("Release-Notizen und Manifest", () => {
  it("Notizen werden geprüft", () => {
    expect(validateNotes({ changes: [{ kind: "neu", text: "Elternsprechtag buchen" }] }).changes).toHaveLength(1);
    expect(() => validateNotes({ changes: [] })).toThrow("mindestens eine Änderung");
    expect(() => validateNotes({ changes: [{ kind: "feature", text: "x" }], minVersion: "1" })).toThrow(
      /minVersion[\s\S]*kind: eines von[\s\S]*text: fehlt/,
    );
    expect(() => validateNotes({ betaDays: -1, changes: [{ kind: "neu", text: "abc" }] })).toThrow("betaDays");
  });

  it("baut ein Manifest: stabil nach 14 Tagen, Mindestversion = vorige Minor-Reihe, sicherheitsrelevant aus den Änderungen", () => {
    const m = buildManifest({
      version: "v1.5.0",
      notes: { changes: [{ kind: "sicherheit", text: "Anmeldung besser geschützt" }] },
      images,
      commit: "abc1234",
      publishedAt: published,
    });
    expect(m).toMatchObject({ schema: 1, version: "1.5.0", minVersion: "1.4.0", securityRelevant: true, stableFrom: "2026-10-19T10:00:00.000Z" });
    expect(release("2.0.0").minVersion).toBe("1.0.0");
    expect(release("0.1.0").minVersion).toBe("0.0.0");
    expect(release("1.5.0-rc.1").stableFrom).toBeNull();
    const now = buildManifest({ version: "1.5.1", notes: { betaDays: 0, changes: [{ kind: "behoben", text: "abc" }] }, images, commit: "abc1234", publishedAt: published });
    expect(now.stableFrom).toBe(now.publishedAt);
  });

  it("lehnt kaputte Manifeste ab", () => {
    expect(() => validateManifest({ ...release("1.0.0"), schema: 2 })).toThrow("Schema 2 wird nicht unterstützt");
    expect(() => validateManifest({ ...release("1.0.0"), images: { ...images, app: "ghcr.io/timow1989/schulos:1.0.0" } })).toThrow(
      "images.app",
    );
    expect(() => validateManifest({ ...release("1.0.0"), minVersion: "1.1.0" })).toThrow("minVersion: liegt nach version");
    expect(() => validateManifest({ ...release("1.0.0"), publishedAt: "gestern", commit: "xyz" })).toThrow(/publishedAt[\s\S]*commit/);
  });

  it("Änderungsliste in Alltagssprache für das GitHub-Release", () => {
    const md = releaseNotesMarkdown({
      ...release("1.5.0"),
      securityRelevant: true,
      changes: [
        { kind: "behoben", text: "Stundenplan druckt wieder" },
        { kind: "neu", text: "Elternsprechtag" },
      ],
    });
    expect(md).toContain("## SchulOS 1.5.0");
    expect(md).toContain("**Sicherheitsrelevant**");
    expect(md.indexOf("### Neu")).toBeLessThan(md.indexOf("### Behoben"));
    expect(md).toContain("ab 2026-10-19 im Kanal stabil");
    expect(md).toContain(images.agent);
  });
});

describe("Kanäle", () => {
  it("beta → stabil nach Ablauf der Beta-Zeit", () => {
    const m = release("1.5.0");
    expect(channelOf(m, new Date("2026-10-18T23:00:00Z"))).toBe("beta");
    expect(channelOf(m, new Date("2026-10-19T10:00:00Z"))).toBe("stabil");
    expect(visibleIn(m, "stabil", new Date("2026-10-10T00:00:00Z"))).toBe(false);
    expect(visibleIn(m, "beta", new Date("2026-10-10T00:00:00Z"))).toBe(true);
    expect(channelOf(release("1.6.0-rc.1"), new Date("2030-01-01T00:00:00Z"))).toBe("beta");
  });
});

describe("Update-Weg", () => {
  const later = new Date("2026-11-30T00:00:00Z");

  it("aktuell, wenn nichts Neueres im Kanal ist", () => {
    expect(planUpdate("1.5.0", [release("1.5.0"), release("1.4.0")], "stabil", later).status).toBe("aktuell");
    expect(planUpdate("1.5.0", [release("1.6.0")], "stabil", new Date("2026-10-06T00:00:00Z")).status).toBe("aktuell");
  });

  it("Patch direkt, Minor-Sprünge über Zwischenversionen", () => {
    const all = [release("1.3.0"), release("1.3.4"), release("1.4.0"), release("1.4.2"), release("1.5.0"), release("1.5.1")];
    const patch = planUpdate("1.5.0", all, "stabil", later);
    expect(patch).toMatchObject({ status: "verfügbar", kind: "patch" });
    expect(patch.steps.map((s) => s.version)).toEqual(["1.5.1"]);
    // 1.3.4 → 1.5.1 (minVersion 1.4.0) geht nur über 1.4.2
    const jump = planUpdate("1.3.4", all, "stabil", later);
    expect(jump.steps.map((s) => s.version)).toEqual(["1.4.2", "1.5.1"]);
    expect(jump).toMatchObject({ kind: "minor", securityRelevant: false });
  });

  it("blockiert, wenn eine Zwischenversion fehlt", () => {
    const plan = planUpdate("1.2.0", [release("1.4.0"), release("1.5.0")], "stabil", later);
    expect(plan).toMatchObject({ status: "blockiert" });
    if (plan.status === "blockiert") expect(plan.reason).toContain("Von 1.2.0 führt kein Weg zu 1.5.0");
  });

  it("beta sieht Vorabversionen, stabil nicht; sicherheitsrelevant über alle Schritte", () => {
    const all = [release("1.5.0"), release("1.5.1", { securityRelevant: true }), release("1.6.0-rc.1")];
    expect(planUpdate("1.5.0", all, "beta", later)).toMatchObject({ kind: "minor", securityRelevant: true });
    expect(planUpdate("1.5.0", all, "beta", later).steps.map((s) => s.version)).toEqual(["1.6.0-rc.1"]);
    expect(planUpdate("1.5.0", all, "stabil", later)).toMatchObject({ kind: "patch", securityRelevant: true });
  });
});

describe("Signatur (cosign sign-blob)", () => {
  it("prüft eine echte cosign-Signatur (Schlüsselpaar und Signatur aus cosign v3, test-fixtures)", () => {
    const dir = new URL("../test-fixtures/", import.meta.url);
    const data = readFileSync(new URL("release.json", dir));
    const sig = readFileSync(new URL("release.json.sig", dir), "utf8");
    const pub = readFileSync(new URL("cosign-test.pub", dir), "utf8");
    expect(verifyManifestSignature(data, sig, pub)).toBe(true);
    expect(loadSignedManifest(data, sig, pub).version).toBe("0.1.0");
    const tampered = Buffer.from(data.toString("utf8").replace("0.1.0", "9.9.9"));
    expect(verifyManifestSignature(tampered, sig, pub)).toBe(false);
    expect(() => loadSignedManifest(tampered, sig, pub)).toThrow("Signatur des Release-Manifests ist ungültig");
  });

  it("falscher Schlüssel oder Unsinn als Signatur → ungültig, ohne Ausnahme", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const data = Buffer.from(JSON.stringify(release("1.0.0")));
    const sig = sign("sha256", data, privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyManifestSignature(data, sig, pem)).toBe(true);
    expect(verifyManifestSignature(data, sig, other)).toBe(false);
    expect(verifyManifestSignature(data, "", pem)).toBe(false);
    expect(verifyManifestSignature(data, "kein-base64!!", pem)).toBe(false);
    expect(verifyManifestSignature(data, sig, "kein Schlüssel")).toBe(false);
  });
});

describe("Wöchentlicher Neubau (B-30)", () => {
  const up = (n: string) => ({
    node: `node:24-alpine@${digest(n)}`,
    caddy: `caddy:2@${digest("c")}`,
  });

  it("Patch-Version und neuestes fertiges Release", () => {
    expect(nextPatch("1.4.2")).toBe("1.4.3");
    expect(() => nextPatch("1.5.0-rc.1")).toThrow("Vorabversion");
    expect(latestFinal(["1.4.2", "1.10.0", "1.11.0-rc.1", "kaputt", "1.9.9"])).toBe("1.10.0");
    expect(latestFinal(["0.1.0-rc.1"])).toBeNull();
  });

  it("erkennt geänderte Fremd-Images am Digest", () => {
    expect(changedUpstream(up("a"), up("a"))).toEqual([]);
    expect(changedUpstream(up("a"), up("b"))).toEqual(["node"]);
    expect(changedUpstream(up("a"), { ...up("a"), postgres: `postgres:18@${digest("d")}` })).toEqual(["postgres"]);
    expect(changedUpstream(undefined, up("a"))).toEqual(["caddy", "node"]);
  });

  it("automatisches Patch-Release: sicherheitsrelevant, kürzere Beta-Zeit, Manifest mit upstream", () => {
    const notes = autoPatchNotes(["node", "postgres"]);
    expect(notes.changes[0]!.text).toContain("(Node.js, PostgreSQL)");
    const m = buildManifest({ version: "1.4.3", notes, images, commit: "abc1234", publishedAt: published, upstream: up("b") });
    expect(m).toMatchObject({ securityRelevant: true, stableFrom: "2026-10-08T10:00:00.000Z", upstream: up("b") });
    expect(() => validateManifest({ ...m, upstream: { node: "node:24-alpine" } })).toThrow("upstream.node");
    expect(buildManifest({ version: "1.4.3", notes, images, commit: "abc1234", publishedAt: published, upstream: {} })).not.toHaveProperty("upstream");
  });
});

describe("Fremd-Images aus Dockerfiles und Compose (B-30)", () => {
  it("sammelt Basis- und Stack-Images, eigene Images nicht", () => {
    const docker = "ARG NODE_IMAGE=node:24-alpine\nARG RESTIC_IMAGE=restic/restic:0.19.1\nFROM ${NODE_IMAGE} AS deps\n";
    const compose = "services:\n  caddy:\n    image: ${SCHULOS_CADDY_IMAGE:-caddy:2}\n  app:\n    image: ${SCHULOS_IMAGE:-schulos:dev}\n  rest:\n    image: \"restic/rest-server:0.14.0\"\n  db:\n    image: postgres:18\n";
    expect(upstreamRefs([docker, docker, compose])).toEqual({
      node: "node:24-alpine",
      restic: "restic/restic:0.19.1",
      caddy: "caddy:2",
      "rest-server": "restic/rest-server:0.14.0",
      postgres: "postgres:18",
    });
    expect(() => upstreamRefs([docker, "ARG NODE_IMAGE=node:22-alpine"])).toThrow("node in zwei Versionen");
  });

  it("die echten Dateien im Repo", () => {
    const root = new URL("../../../", import.meta.url);
    const files = ["Dockerfile", "apps/backup/Dockerfile", "apps/agent/Dockerfile", "compose.yaml", "compose.backup.yaml"];
    const refs = upstreamRefs(files.map((f) => readFileSync(new URL(f, root), "utf8")));
    expect(Object.keys(refs).sort()).toEqual(["caddy", "clamav", "crowdsec", "node", "postgres", "rclone", "rest-server", "restic", "step-ca"]);
    // B-47: jede Vorgabe ist in der Pin-Datei mit genau diesem Tag gepinnt (Dependabot-Tag-Anhebung → hier rot)
    const pins = parsePins(readFileSync(new URL(UPSTREAM_PINS_FILE, root), "utf8"));
    expect(Object.keys(pinUpstream(refs, pins)).sort()).toEqual(Object.keys(refs).sort());
    expect(Object.keys(pins)).toEqual(expect.arrayContaining(["iso-build", "syft"]));
  });

  it("Pins (B-47): Datei lesen und den Vorgaben zuordnen", () => {
    const text = `# Kommentar\nFROM node:24-alpine@${digest("1")} AS node\nFROM caddy:2@${digest("2")} AS caddy\nFROM node:24-trixie@${digest("3")} AS iso-build\n`;
    const pins = parsePins(text);
    expect(pins).toEqual({ node: `node:24-alpine@${digest("1")}`, caddy: `caddy:2@${digest("2")}`, "iso-build": `node:24-trixie@${digest("3")}` });
    expect(pinUpstream({ node: "node:24-alpine", caddy: "caddy:2" }, pins)).toEqual({ node: `node:24-alpine@${digest("1")}`, caddy: `caddy:2@${digest("2")}` });
    // Tag angehoben (Dependabot) oder Vorgabe geändert → Fehler statt stiller Mischung
    expect(() => pinUpstream({ postgres: "postgres:18" }, pins)).toThrow(/postgres:18 \(postgres\) nicht in deploy\/upstream\/Dockerfile/);
    expect(() => parsePins("FROM caddy:2 AS caddy")).toThrow("ohne Tag und Digest");
    expect(() => parsePins(`FROM caddy:2@${digest("2")} AS c\nFROM caddy:2@${digest("3")} AS c`)).toThrow("doppelt");
  });
});

describe("Release-ISO (B-49)", () => {
  const upstream = {
    node: `node:24-alpine@${digest("1")}`,
    caddy: `caddy:2@${digest("2")}`,
    postgres: `postgres:18@${digest("3")}`,
    "rest-server": `restic/rest-server:0.14.0@${digest("4")}`,
  };

  it("eigene Images unter <repo>:<version>, Fremd-Images unter ihrem Tag, jeweils per Digest gezogen", () => {
    const { images: list, env } = isoImages(release("0.2.0-rc.1", { upstream }));
    expect(list).toEqual([
      { file: "schulos", ref: images.app, tag: "ghcr.io/timow1989/schulos:0.2.0-rc.1", signed: true },
      { file: "schulos-agent", ref: images.agent, tag: "ghcr.io/timow1989/schulos-agent:0.2.0-rc.1", signed: true },
      { file: "schulos-backup", ref: images.backup, tag: "ghcr.io/timow1989/schulos-backup:0.2.0-rc.1", signed: true },
      { file: "caddy", ref: upstream.caddy, tag: "caddy:2", signed: false },
      { file: "postgres", ref: upstream.postgres, tag: "postgres:18", signed: false },
      { file: "rest-server", ref: upstream["rest-server"], tag: "restic/rest-server:0.14.0", signed: false },
    ]);
    expect(env).toEqual({
      SCHULOS_IMAGE: "ghcr.io/timow1989/schulos:0.2.0-rc.1",
      SCHULOS_AGENT_IMAGE: "ghcr.io/timow1989/schulos-agent:0.2.0-rc.1",
      SCHULOS_BACKUP_IMAGE: "ghcr.io/timow1989/schulos-backup:0.2.0-rc.1",
      SCHULOS_CADDY_IMAGE: "caddy:2",
      SCHULOS_POSTGRES_IMAGE: "postgres:18",
      SCHULOS_REST_IMAGE: "restic/rest-server:0.14.0",
    });
  });

  it("G4E-O10: Profil-Images (ClamAV, CrowdSec, step-ca) per Digest in images.env, nicht auf dem Medium", () => {
    const profile = {
      clamav: `clamav/clamav:1.5.4@${digest("5")}`,
      crowdsec: `crowdsecurity/crowdsec:v1.8.1@${digest("6")}`,
      "step-ca": `smallstep/step-ca:0.30.2@${digest("7")}`,
    };
    const { images: list, env } = isoImages(release("0.5.0", { upstream: { ...upstream, ...profile } }));
    expect(list.map((i) => i.file)).not.toContain("clamav");
    expect(env).toMatchObject({
      SCHULOS_CLAMAV_IMAGE: profile.clamav,
      SCHULOS_CROWDSEC_IMAGE: profile.crowdsec,
      SCHULOS_STEP_CA_IMAGE: profile["step-ca"],
    });
    // pinImagesEnv nimmt die schon gepinnten Werte unverändert
    const text = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const pinned = pinImagesEnv(text, new Map(Object.values(env).filter((v) => !v.includes("@")).map((v) => [v, digest("9")])));
    expect(pinned).toContain(`SCHULOS_CLAMAV_IMAGE=${profile.clamav}`);
    expect(profileImageEnv({ upstream: { clamav: "clamav/clamav:1.5.4" } })).toEqual({});
  });

  it("Release ohne Fremd-Images (vor B-30) oder ohne Tag → Fehler", () => {
    expect(() => isoImages(release("0.1.0"))).toThrow("nennt kein Fremd-Image „caddy“");
    const ohneRest = Object.fromEntries(Object.entries(upstream).filter(([name]) => name !== "rest-server")) as typeof upstream;
    expect(() => isoImages(release("0.1.0", { upstream: ohneRest }))).toThrow("„rest-server“");
    expect(() => isoImages(release("0.1.0", { upstream: { ...upstream, caddy: `caddy@${digest("2")}` } }))).toThrow("upstream.caddy: Tag fehlt");
  });
});

describe("SEC-08: Digest-Referenzen nach der ISO-Installation", () => {
  const index = (...digests: string[]) =>
    JSON.stringify({ schemaVersion: 2, manifests: digests.map((d) => ({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: d, size: 1 })) });

  it("Digest eines Archivs aus der index.json – genau ein Image, gültiger sha256", () => {
    expect(archiveDigest(index(digest("a")))).toBe(digest("a"));
    expect(() => archiveDigest(index())).toThrow("genau ein Image");
    expect(() => archiveDigest(index(digest("a"), digest("b")))).toThrow("genau ein Image");
    expect(() => archiveDigest(index("sha256:kurz"))).toThrow("kein gültiger Digest");
    expect(() => archiveDigest("{}")).toThrow("genau ein Image");
  });

  it("images.env: jeder Tag bekommt seinen Digest (Tag bleibt für den Postgres-Vergleich), fehlender Digest → Fehler", () => {
    const env = [
      "# Images auf dem Startmedium",
      "SCHULOS_IMAGE=ghcr.io/timow1989/schulos:0.5.0",
      "SCHULOS_POSTGRES_IMAGE=postgres:18",
      "SCHULOS_REST_IMAGE=restic/rest-server:0.14.0",
      "",
    ].join("\n");
    const digests = new Map([
      ["ghcr.io/timow1989/schulos:0.5.0", digest("1")],
      ["postgres:18", digest("2")],
      ["restic/rest-server:0.14.0", digest("3")],
    ]);
    expect(pinImagesEnv(env, digests)).toBe(
      [
        "# Images auf dem Startmedium",
        `SCHULOS_IMAGE=ghcr.io/timow1989/schulos:0.5.0@${digest("1")}`,
        `SCHULOS_POSTGRES_IMAGE=postgres:18@${digest("2")}`,
        `SCHULOS_REST_IMAGE=restic/rest-server:0.14.0@${digest("3")}`,
        "",
      ].join("\n"),
    );
    // schon gepinnt: bleibt (zweiter Lauf ändert nichts)
    expect(pinImagesEnv(pinImagesEnv(env, digests), new Map())).toBe(pinImagesEnv(env, digests));
    expect(() => pinImagesEnv("SCHULOS_IMAGE=schulos:0.5.0\n", new Map())).toThrow("kein Digest für schulos:0.5.0");
    expect(() => pinImagesEnv("SCHULOS_IMAGE=schulos:0.5.0@sha256:x\n", new Map())).toThrow("ungültiger Digest");
  });

  it("alle Images der Stacks kommen aus Variablen – sonst wirkte der Digest aus der .env nicht", () => {
    const root = new URL("../../../", import.meta.url);
    for (const f of ["compose.yaml", "compose.backup.yaml"]) {
      const text = readFileSync(new URL(f, root), "utf8");
      for (const m of text.matchAll(/^\s*image:\s*(\S+)\s*$/gm)) expect(m[1], `${f}: ${m[1]}`).toMatch(/^\$\{SCHULOS_(?:[A-Z_]+_)?IMAGE:-[^}]+\}$/);
    }
    // jede Variable der Stacks, die die ISO mitbringt, steht in images.env der Release-ISO
    const upstream = {
      caddy: `caddy:2@${digest("2")}`,
      postgres: `postgres:18@${digest("3")}`,
      "rest-server": `restic/rest-server:0.14.0@${digest("4")}`,
    };
    const { env } = isoImages(release("0.5.0", { upstream }));
    expect(Object.keys(env).sort()).toEqual(
      ["SCHULOS_AGENT_IMAGE", "SCHULOS_BACKUP_IMAGE", "SCHULOS_CADDY_IMAGE", "SCHULOS_IMAGE", "SCHULOS_POSTGRES_IMAGE", "SCHULOS_REST_IMAGE"].sort(),
    );
  });

  it("iso/build-docker.sh stellt images.env für beide Wege (Release und Neubau) um", () => {
    const sh = readFileSync(new URL("../../../iso/build-docker.sh", import.meta.url), "utf8");
    const pin = sh.indexOf("tsx scripts/release-manifest.ts --pin-images");
    expect(pin).toBeGreaterThan(sh.indexOf("REFS=(schulos:$VERSION"));
    expect(pin).toBeLessThan(sh.indexOf("== Stückliste"));
    expect(sh).toContain('digest_of "$2" "$d/index.json"');
    expect(sh).toContain('digest_of "$1:$VERSION"');
    expect(sh).toContain("SCHULOS_REST_IMAGE=$REST");
  });
});
