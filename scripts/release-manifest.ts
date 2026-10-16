// Werkzeug des Release-Workflows (B-29/B-30, INSTALLATION.md §5a.2, Ablauf in release/README.md). Läuft mit `npx tsx`,
// braucht nur Node-Bordmittel (der Workflow spart sich `npm ci`):
//   --check 1.5.0                        Notizen release/notes/<version>.json prüfen
//   --upstream-refs <ordner>             Fremd-Images aus Dockerfiles/Compose des Build-Stands (Zeilen name=ref), mit Digest
//                                        aus deploy/upstream/Dockerfile (B-47), falls der Stand die Pin-Datei hat
//   --latest                             neuestes fertiges Release aus den Tags auf stdin
//   --changed <release.json> --upstream <upstream.json>   geänderte Fremd-Images seit dem Release (Komma-Liste, leer = keine)
//   --version 1.5.0 --commit <sha> --app/--backup/--agent <ref@sha256:…> --out <ordner> [--upstream <json>] [--auto-patch <namen>]
//                                        release.json + release-notes.md schreiben (danach mit cosign signieren, Bytes nicht ändern)
//                                        [--files <ordner>]: Host-Dateien (schulosctl.mjs, compose.yaml) daraus mit SHA-256 ins
//                                        Manifest (GATE-031 C-01) – sie hängen als Anhang am Release
//   --hostfiles <ordner>                 nach dem Download: Host-Dateien im Ordner gegen release.json(+.sig) prüfen
//   --verify <ordner>                    release.json + .sig gegen release/cosign.pub prüfen
//   --iso <ordner>                       wie --verify, dann für die Release-ISO (B-49) in den Ordner: images.txt (Zeilen
//                                        „datei ref tag signiert“), images.env, release.env (VERSION, COMMIT)
//   --pin-images <images.env> --digests <datei>
//                                        SEC-08 (ISO-Bau): images.env auf name:tag@sha256:… umstellen; Digests aus der Datei
//                                        (Zeilen „tag pfad/zur/index.json“ des jeweiligen Image-Archivs)
// Notizen: release/notes/<version>.json (bei Vorabversionen 1.5.0-rc.1 die von 1.5.0); automatische Patch-Releases
// (--auto-patch) brauchen keine Datei.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  autoPatchNotes,
  buildManifest,
  changedUpstream,
  isoImages,
  archiveDigest,
  pinImagesEnv,
  formatVersion,
  latestFinal,
  loadSignedManifest,
  parsePins,
  parseVersion,
  pinUpstream,
  releaseNotesMarkdown,
  UPSTREAM_PINS_FILE,
  upstreamRefs,
  validateManifest,
  validateNotes,
  HOST_FILES,
  sha256Hex,
  verifyHostFile,
  type HostFile,
} from "../packages/server/src/release";

const { values } = parseArgs({
  options: {
    check: { type: "string" },
    verify: { type: "string" },
    iso: { type: "string" },
    "upstream-refs": { type: "string" },
    latest: { type: "boolean" },
    changed: { type: "string" },
    upstream: { type: "string" },
    "auto-patch": { type: "string" },
    version: { type: "string" },
    commit: { type: "string" },
    app: { type: "string" },
    backup: { type: "string" },
    agent: { type: "string" },
    out: { type: "string", default: "." },
    files: { type: "string" },
    hostfiles: { type: "string" },
    "pin-images": { type: "string" },
    digests: { type: "string" },
  },
});

/** SHA-256 der vorhandenen Host-Dateien eines Ordners (fehlende werden ausgelassen). */
function hostFileHashes(dir: string): Partial<Record<HostFile, string>> {
  const out: Partial<Record<HostFile, string>> = {};
  for (const name of HOST_FILES) {
    const f = join(dir, name);
    if (existsSync(f)) out[name] = sha256Hex(readFileSync(f));
  }
  return out;
}

const UPSTREAM_SOURCES = ["Dockerfile", "apps/backup/Dockerfile", "apps/agent/Dockerfile", "compose.yaml", "compose.backup.yaml"];

function loadNotes(version: string) {
  const v = parseVersion(version);
  const core = formatVersion({ ...v, prerelease: [] });
  const file = [formatVersion(v), core].map((n) => join("release", "notes", `${n}.json`)).find((f) => existsSync(f));
  if (!file) throw new Error(`Keine Release-Notizen: release/notes/${core}.json anlegen (siehe release/README.md)`);
  return validateNotes(JSON.parse(readFileSync(file, "utf8")));
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;

try {
  if (values.verify || values.iso) {
    // nach dem Signieren: passt das Secret zum öffentlichen Schlüssel im Repo (den schulosctl mitbringt)?
    const dir = (values.verify ?? values.iso)!;
    const m = loadSignedManifest(
      readFileSync(join(dir, "release.json")),
      readFileSync(join(dir, "release.json.sig"), "utf8"),
      readFileSync(join("release", "cosign.pub"), "utf8"),
    );
    console.log(`Signatur von release.json (${m.version}) mit release/cosign.pub geprüft`);
    if (values.iso) {
      const { images, env } = isoImages(m);
      const lines = (l: string[]) => l.map((x) => x + "\n").join("");
      writeFileSync(join(dir, "images.txt"), lines(images.map((i) => `${i.file} ${i.ref} ${i.tag} ${i.signed ? 1 : 0}`)));
      writeFileSync(join(dir, "images.env"), lines(Object.entries(env).map(([k, v]) => `${k}=${v}`)));
      writeFileSync(join(dir, "release.env"), lines([`VERSION=${m.version}`, `COMMIT=${m.commit}`]));
    }
  } else if (values["pin-images"]) {
    const envFile = values["pin-images"];
    if (!values.digests) throw new Error("--pin-images braucht --digests <datei>");
    const digests = new Map<string, string>();
    for (const line of readFileSync(values.digests, "utf8").split("\n").filter((l) => l.trim())) {
      const [tag, file] = line.trim().split(/\s+/);
      if (!tag || !file) throw new Error(`digests.txt: Zeile „${line}“ – erwartet „tag pfad“`);
      digests.set(tag, archiveDigest(readFileSync(file, "utf8")));
    }
    writeFileSync(envFile, pinImagesEnv(readFileSync(envFile, "utf8"), digests));
    console.log(`images.env mit ${digests.size} Digests (SEC-08)`);
  } else if (values.hostfiles) {
    const dir = values.hostfiles;
    const m = loadSignedManifest(readFileSync(join(dir, "release.json")), readFileSync(join(dir, "release.json.sig"), "utf8"), readFileSync(join("release", "cosign.pub"), "utf8"));
    for (const name of HOST_FILES) verifyHostFile(m, name, readFileSync(join(dir, name)));
    console.log(`Host-Dateien ${HOST_FILES.join(", ")} passen zum signierten Manifest ${m.version}`);
  } else if (values.check) {
    const notes = loadNotes(values.check);
    console.log(`Release-Notizen für ${values.check} in Ordnung (${notes.changes.length} Änderungen)`);
  } else if (values["upstream-refs"]) {
    const dir = values["upstream-refs"];
    let refs = upstreamRefs(UPSTREAM_SOURCES.map((f) => readFileSync(join(dir, f), "utf8")));
    const pins = join(dir, UPSTREAM_PINS_FILE);
    if (existsSync(pins)) refs = pinUpstream(refs, parsePins(readFileSync(pins, "utf8")));
    for (const [name, ref] of Object.entries(refs)) console.log(`${name}=${ref}`);
  } else if (values.latest) {
    const tags = readFileSync(0, "utf8").split(/\s+/).filter(Boolean);
    console.log(latestFinal(tags) ?? "");
  } else if (values.changed) {
    if (!values.upstream) throw new Error("--upstream <upstream.json> angeben");
    const release = validateManifest(readJson(values.changed));
    console.log(changedUpstream(release.upstream, readJson(values.upstream) as Record<string, string>).join(","));
  } else {
    const { version, commit, app, backup, agent } = values;
    if (!version || !commit || !app || !backup || !agent) throw new Error("--version, --commit, --app, --backup und --agent angeben");
    const auto = values["auto-patch"];
    const notes = auto ? autoPatchNotes(auto.split(",").filter(Boolean)) : loadNotes(version);
    const upstream = values.upstream ? (readJson(values.upstream) as Record<string, string>) : undefined;
    const files = values.files ? hostFileHashes(values.files) : undefined;
    if (values.files && Object.keys(files!).length !== HOST_FILES.length) throw new Error(`--files ${values.files}: erwartet ${HOST_FILES.join(", ")}`);
    const manifest = buildManifest({ version, notes, images: { app, backup, agent }, commit, publishedAt: new Date(), upstream, files });
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, "release.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(values.out, "release-notes.md"), releaseNotesMarkdown(manifest));
    console.log(`release.json für ${manifest.version} geschrieben (stabil ab ${manifest.stableFrom ?? "nie – Vorabversion"})`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
