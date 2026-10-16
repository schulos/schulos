// Offline-Bundle (B-36, INSTALLATION.md §5a.2): Updates ohne Internet per USB-Stick.
// Inhalt: releases/v<version>/release.json + .sig (signiert), images.tar (docker save), bundle.json (Übersicht).
// Beim Import zählen nur Images, die ein signaturgeprüftes Manifest per Digest nennt; die Image-ID nach `docker load`
// muss genau dieser Digest sein (containerd-Image-Speicher: ID = Manifest-Digest), erst dann wird das Image benannt.
// SEC-06: `docker load` übernimmt Namen aus dem Archiv selbst (index.json-Annotationen, manifest.json „RepoTags“, alte
// „repositories“-Datei). Darum wird das Archiv vor dem Laden geprüft (`checkImageArchive`): nur die signierten Digests, und
// Namen höchstens die, die der Import ohnehin selbst vergibt – sonst könnte ein manipuliertes Bundle z. B. `postgres:18` oder
// die laufende App-Version auf ein fremdes Image umbiegen.
import type { ReleaseManifest } from "@schulos/server/release";

/** Fremd-Images, die zur Laufzeit gebraucht werden (node/restic sind nur Basis der eigenen Images). */
export const RUNTIME_UPSTREAM = ["caddy", "postgres", "rest-server"];

export interface BundleImage {
  /** Referenz mit Digest, wie im Manifest (z. B. ghcr.io/schulos/schulos@sha256:…, caddy:2@sha256:…) */
  ref: string;
  digest: string;
  /** Name:Tag, unter dem das geladene Image lokal benannt wird – damit name@digest offline auflösbar ist */
  tag: string;
}

/** Alle Images der Releases, ohne Doppelte. Eigene Images ohne Tag bekommen die Release-Version als Tag. */
export function bundleImages(manifests: ReleaseManifest[]): BundleImage[] {
  const out = new Map<string, BundleImage>();
  for (const m of manifests) {
    const refs = [m.images.app, m.images.backup, m.images.agent, ...RUNTIME_UPSTREAM.map((n) => m.upstream?.[n]).filter((r): r is string => !!r)];
    for (const ref of refs) {
      if (out.has(ref)) continue;
      const [name, digest] = ref.split("@") as [string, string];
      const lastPart = name.slice(name.lastIndexOf("/") + 1);
      const tag = lastPart.includes(":") ? name : `${name}:${m.version}`;
      out.set(ref, { ref, digest, tag });
    }
  }
  return [...out.values()];
}

export interface BundleInfo {
  version: 1;
  createdAt: string;
  versions: string[];
  images: string[];
}

export function bundleInfo(manifests: ReleaseManifest[], now = new Date()): BundleInfo {
  return { version: 1, createdAt: now.toISOString(), versions: manifests.map((m) => m.version), images: bundleImages(manifests).map((i) => i.ref) };
}

/** Image-IDs aus der Ausgabe von `docker load` („Loaded image ID: sha256:…“ bzw. „Loaded image: name@sha256:…“). */
export function loadedDigests(output: string): Set<string> {
  return new Set([...output.matchAll(/sha256:[a-f0-9]{64}/g)].map((m) => m[0]));
}

/** Name ohne Docker-Hub-Vorsatz („docker.io/library/caddy:2“ → „caddy:2“), zum Vergleich. */
function normalizeName(name: string): string {
  return name.replace(/^docker\.io\/library\//, "").replace(/^docker\.io\//, "");
}

export interface ImageArchive {
  /** Inhalt von index.json (OCI-Layout) bzw. null */
  index: string | null;
  /** Inhalt von manifest.json (docker-archive) bzw. null */
  manifest: string | null;
  /** Inhalt der alten Datei „repositories“ bzw. null */
  repositories: string | null;
}

/** Archiv aus `docker save` vor `docker load` prüfen. Liefert die Beanstandungen (leer = in Ordnung). */
export function checkImageArchive(a: ImageArchive, images: BundleImage[]): string[] {
  const digests = new Set(images.map((i) => i.digest));
  const names = new Set(images.map((i) => normalizeName(i.tag)));
  const problems: string[] = [];
  const nameOk = (n: unknown) => typeof n === "string" && names.has(normalizeName(n));
  const parse = (label: string, text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      problems.push(`${label} nicht lesbar`);
      return null;
    }
  };
  if (!a.index && !a.manifest) return ["images.tar enthält weder index.json noch manifest.json"];
  if (a.index) {
    const idx = parse("index.json", a.index) as { manifests?: { digest?: unknown; annotations?: Record<string, unknown> }[] } | null;
    if (idx && !Array.isArray(idx.manifests)) problems.push("index.json ohne Manifest-Liste");
    for (const m of idx?.manifests ?? []) {
      if (typeof m.digest !== "string" || !digests.has(m.digest)) problems.push(`fremdes Image ${String(m.digest).slice(0, 80)}`);
      const ann = m.annotations ?? {};
      const full = ann["io.containerd.image.name"];
      if (full !== undefined && !nameOk(full)) problems.push(`fremder Name ${String(full).slice(0, 80)}`);
      // org.opencontainers.image.ref.name ist nur der Tag-Teil; ohne vollen Namen nicht zuzuordnen → nicht erlaubt
      const ref = ann["org.opencontainers.image.ref.name"];
      if (ref !== undefined && full === undefined) problems.push(`Name ohne Bezug ${String(ref).slice(0, 80)}`);
    }
  }
  if (a.manifest) {
    const man = parse("manifest.json", a.manifest);
    if (man !== null && !Array.isArray(man)) problems.push("manifest.json ist keine Liste");
    for (const e of Array.isArray(man) ? (man as { RepoTags?: unknown }[]) : []) {
      if (e.RepoTags === null || e.RepoTags === undefined) continue;
      if (!Array.isArray(e.RepoTags)) {
        problems.push("manifest.json: RepoTags ungültig");
        continue;
      }
      for (const t of e.RepoTags as unknown[]) if (!nameOk(t)) problems.push(`fremder Name ${String(t).slice(0, 80)}`);
    }
  }
  if (a.repositories) {
    const repos = parse("repositories", a.repositories);
    if (repos && typeof repos === "object")
      for (const [repo, tags] of Object.entries(repos as Record<string, Record<string, unknown>>))
        for (const tag of Object.keys(tags ?? {})) if (!nameOk(`${repo}:${tag}`)) problems.push(`fremder Name ${repo}:${tag}`.slice(0, 100));
  }
  return [...new Set(problems)];
}
