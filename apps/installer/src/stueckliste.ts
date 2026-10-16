// Stückliste (B-48): was genau eine ISO ausliefert – Debian-Pakete mit Version (Offline-Quelle = genau das, was auf dem Zielsystem
// landet; dazu das Live-System), Images mit ID/Digest, Node-Version, Git-Commit. Auch ohne bitgleichen Build nachvollziehbar.
// Rein; zusammengesetzt beim ISO-Bau (`schulos-installer --stueckliste`, iso/build.sh), auf dem Medium und im installierten System
// unter /usr/share/doc/schulos/stueckliste.json. Den Inhalt der Images beschreiben zusätzlich CycloneDX-SBOMs (syft) neben der ISO.

export const STUECKLISTE_FORMAT = "schulos-stueckliste/1";

export interface Paket {
  name: string;
  version: string;
  arch: string;
}

export interface ImageEintrag {
  /** Name wie in images.env, z. B. schulos:1.2.0 bzw. postgres:18 */
  ref: string;
  /** Image-ID (containerd: Manifest-Digest) */
  id: string;
  /** Registry-Digests (Fremd-Images); bei selbst gebauten leer */
  digests: string[];
}

export interface Stueckliste {
  format: typeof STUECKLISTE_FORMAT;
  version: string;
  commit: string;
  erstellt: string;
  node: string;
  debian: { quelle: string; zielsystem: Paket[]; liveSystem?: Paket[] };
  images: ImageEintrag[];
}

/** Debian-„Packages“-Datei (apt-ftparchive) → Pakete, sortiert */
export function parsePackages(text: string): Paket[] {
  const out: Paket[] = [];
  for (const stanza of text.split(/\n\s*\n/)) {
    const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(stanza)?.[1]?.trim();
    const name = field("Package");
    const version = field("Version");
    if (name && version) out.push({ name, version, arch: field("Architecture") ?? "" });
  }
  return sortPakete(out);
}

/** `dpkg-query -W -f '${Package}\t${Version}\t${Architecture}\n'` → Pakete, sortiert */
export function parseDpkgQuery(text: string): Paket[] {
  return sortPakete(
    text
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 2 && p[0] && p[1])
      .map(([name, version, arch]) => ({ name: name!, version: version!, arch: arch ?? "" })),
  );
}

function sortPakete(p: Paket[]): Paket[] {
  return p.sort((a, b) => (a.name === b.name ? a.arch.localeCompare(b.arch) : a.name < b.name ? -1 : 1));
}

/** `docker image inspect <refs…>` (JSON-Liste) → Images in der Reihenfolge der Refs */
export function parseImageInspect(json: string, refs: string[]): ImageEintrag[] {
  const all = JSON.parse(json) as { Id?: string; RepoTags?: string[]; RepoDigests?: string[] }[];
  return refs.map((ref) => {
    const hit = all.find((i) => i.RepoTags?.includes(ref) || i.RepoTags?.includes(`docker.io/library/${ref}`) || i.RepoTags?.includes(`docker.io/${ref}`));
    if (!hit?.Id) throw new Error(`Image ${ref} fehlt in docker image inspect`);
    return { ref, id: hit.Id, digests: [...(hit.RepoDigests ?? [])].sort() };
  });
}

/** Bauzeit für reproduzierbare Builds (B-47): SOURCE_DATE_EPOCH (Sekunden) statt „jetzt“, sonst undefined */
export function sourceDate(epoch: string | undefined): Date | undefined {
  if (!epoch) return undefined;
  if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH „${epoch}“ ist keine Zahl`);
  return new Date(Number(epoch) * 1000);
}

export function buildStueckliste(i: Omit<Stueckliste, "format" | "erstellt"> & { erstellt?: Date }): Stueckliste {
  if (!/^[0-9a-f]{7,40}$/.test(i.commit)) throw new Error(`Commit „${i.commit}“ ist kein Git-Hash`);
  if (!i.debian.zielsystem.length) throw new Error("Keine Debian-Pakete");
  if (!i.images.length) throw new Error("Keine Images");
  const { erstellt, ...rest } = i;
  return { format: STUECKLISTE_FORMAT, ...rest, erstellt: (erstellt ?? new Date()).toISOString() };
}
