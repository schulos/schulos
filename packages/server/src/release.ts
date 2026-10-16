// Releases (INSTALLATION.md §5a.2): SemVer, Release-Manifest, Kanäle beta → stabil, Update-Weg, Signaturprüfung.
// Rein, gemeinsam für Release-Workflow (scripts/release-manifest.ts), schulosctl und Verwaltung → System.
// Das Manifest ist die Quelle der Wahrheit für ein Update: Es nennt die Images per Digest und ist mit dem
// cosign-Schlüssel signiert (`cosign sign-blob`, ECDSA P-256 über SHA-256) – wer die Signatur prüft und die
// Images per Digest zieht, bekommt genau das, was der Release-Workflow gebaut hat.
import { createHash, verify } from "node:crypto";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Vorabversion, z. B. ["rc", 1] bei 1.2.0-rc.1 */
  prerelease: (string | number)[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(s: string): Version {
  const m = SEMVER.exec(s.trim());
  if (!m) throw new Error(`Keine gültige Versionsnummer: „${s}“ (erwartet z. B. 1.4.2 oder 1.5.0-rc.1)`);
  const prerelease = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

export function formatVersion(v: Version): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease.length ? `${core}-${v.prerelease.join(".")}` : core;
}

/** SemVer-Rangfolge: < 0 wenn a älter als b. Vorabversionen liegen vor der fertigen Version. */
export function compareVersions(a: string | Version, b: string | Version): number {
  const x = typeof a === "string" ? parseVersion(a) : a;
  const y = typeof b === "string" ? parseVersion(b) : b;
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export type UpdateKind = "patch" | "minor" | "major";

/** Art des Sprungs von → nach (für die Update-Regeln: Patch automatisch, Minor/Major nach Freigabe). */
export function updateKind(from: string, to: string): UpdateKind {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (a.major !== b.major) return "major";
  if (a.minor !== b.minor) return "minor";
  return "patch";
}

export type Channel = "beta" | "stabil";
export const CHANNELS: Channel[] = ["stabil", "beta"];
/** So lange ist ein Release nur im Kanal beta, bevor es stabil wird (Vorgabe, je Release im Manifest festgehalten). */
export const BETA_DAYS = 14;

export type ImageRole = "app" | "backup" | "agent";
export const IMAGE_ROLES: ImageRole[] = ["app", "backup", "agent"];

export type ChangeKind = "neu" | "verbessert" | "behoben" | "sicherheit";
export const CHANGE_LABEL: Record<ChangeKind, string> = {
  neu: "Neu",
  verbessert: "Verbessert",
  behoben: "Behoben",
  sicherheit: "Sicherheit",
};

export interface ReleaseChange {
  kind: ChangeKind;
  /** in Alltagssprache, ohne Fachbegriffe – so steht es in Verwaltung → System */
  text: string;
}

export const MANIFEST_SCHEMA = 1;

export interface ReleaseManifest {
  schema: typeof MANIFEST_SCHEMA;
  version: string;
  /** ISO-Zeitpunkt der Veröffentlichung (Kanal beta) */
  publishedAt: string;
  /** ab hier im Kanal stabil (Vorgabe: publishedAt + BETA_DAYS); null = nie stabil (z. B. Vorabversion) */
  stableFrom: string | null;
  /** älteste Version, von der aus dieses Release direkt installiert werden darf */
  minVersion: string;
  securityRelevant: boolean;
  changes: ReleaseChange[];
  /** Images per Digest, z. B. ghcr.io/schulos/schulos@sha256:… */
  images: Record<ImageRole, string>;
  /** Git-Commit des Builds */
  commit: string;
  /**
   * Fremd-Images per Digest (B-30): Basis der eigenen Images (node, restic) und die im Stack mitlaufenden
   * (caddy, postgres, rest-server). schulosctl zieht genau diese; der wöchentliche Neubau vergleicht sie.
   * Optional – fehlt in Releases vor B-30.
   */
  upstream?: Record<string, string>;
  /**
   * GATE-031 (C-01): Dateien für den Host als Release-Anhang, je Name der SHA-256 (hex). `schulosctl update` ersetzt damit
   * sich selbst und die Compose-Datei – nur, wenn der Hash zum signierten Manifest passt. Optional (fehlt vor v0.3.2).
   */
  files?: Partial<Record<HostFile, string>>;
}

/** Host-Dateien, die ein Release mitbringen kann (Name = Name des Release-Anhangs und der Datei im Installationsordner). */
export const HOST_FILES = ["schulosctl.mjs", "compose.yaml"] as const;
export type HostFile = (typeof HOST_FILES)[number];

/** SHA-256 (hex) einer Host-Datei – wie im Manifest unter `files`. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Prüft eine heruntergeladene Host-Datei gegen das signierte Manifest; wirft bei fehlendem Eintrag oder falschem Hash. */
export function verifyHostFile(m: ReleaseManifest, name: HostFile, data: Uint8Array): void {
  const want = m.files?.[name];
  if (!want) throw new Error(`${name}: im Release ${m.version} nicht vorgesehen`);
  const got = sha256Hex(data);
  if (got !== want) throw new Error(`${name} aus Release ${m.version}: Prüfsumme passt nicht zum signierten Manifest – nicht übernommen`);
}

/** Fremd-Image mit Tag und Digest, z. B. node:24-alpine@sha256:… oder ghcr.io/x/y:1@sha256:… */
const UPSTREAM_REF = /^[a-z0-9.\-/:]+@sha256:[a-f0-9]{64}$/;

/** Notizen zu einem Release, gepflegt in release/notes/<version>.json (Rest ergänzt der Workflow). */
export interface ReleaseNotes {
  minVersion?: string;
  securityRelevant?: boolean;
  /** abweichende Beta-Zeit in Tagen (0 = sofort stabil, z. B. dringendes Sicherheits-Patch) */
  betaDays?: number;
  changes: ReleaseChange[];
}

const IMAGE_REF = /^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const CHANGE_KINDS = Object.keys(CHANGE_LABEL) as ChangeKind[];

function isIso(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
}

function checkChanges(changes: unknown, errors: string[]): void {
  if (!Array.isArray(changes) || changes.length === 0) {
    errors.push("changes: mindestens eine Änderung angeben");
    return;
  }
  changes.forEach((c, i) => {
    if (!c || typeof c !== "object") return void errors.push(`changes[${i}]: kein Objekt`);
    const { kind, text } = c as Record<string, unknown>;
    if (!CHANGE_KINDS.includes(kind as ChangeKind)) errors.push(`changes[${i}].kind: eines von ${CHANGE_KINDS.join(", ")}`);
    if (typeof text !== "string" || text.trim().length < 3) errors.push(`changes[${i}].text: fehlt`);
    else if (text.length > 300) errors.push(`changes[${i}].text: höchstens 300 Zeichen`);
  });
}

function checkVersion(v: unknown, field: string, errors: string[]): boolean {
  if (typeof v !== "string") {
    errors.push(`${field}: fehlt`);
    return false;
  }
  try {
    parseVersion(v);
    return true;
  } catch (e) {
    errors.push(`${field}: ${(e as Error).message}`);
    return false;
  }
}

/** Prüft die Notizen aus release/notes/<version>.json. */
export function validateNotes(raw: unknown): ReleaseNotes {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") throw new Error("Release-Notizen: kein JSON-Objekt");
  const n = raw as Record<string, unknown>;
  if (n.minVersion !== undefined) checkVersion(n.minVersion, "minVersion", errors);
  if (n.securityRelevant !== undefined && typeof n.securityRelevant !== "boolean") errors.push("securityRelevant: true oder false");
  if (n.betaDays !== undefined && !(Number.isInteger(n.betaDays) && (n.betaDays as number) >= 0 && (n.betaDays as number) <= 90))
    errors.push("betaDays: ganze Zahl 0–90");
  checkChanges(n.changes, errors);
  if (errors.length) throw new Error(`Release-Notizen ungültig:\n- ${errors.join("\n- ")}`);
  return n as unknown as ReleaseNotes;
}

/** Prüft ein Manifest (nach der Signaturprüfung) – unbekannte Schema-Versionen werden abgelehnt. */
export function validateManifest(raw: unknown): ReleaseManifest {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") throw new Error("Release-Manifest: kein JSON-Objekt");
  const m = raw as Record<string, unknown>;
  if (m.schema !== MANIFEST_SCHEMA) throw new Error(`Release-Manifest: Schema ${String(m.schema)} wird nicht unterstützt (erwartet ${MANIFEST_SCHEMA}) – schulosctl aktualisieren`);
  const versionOk = checkVersion(m.version, "version", errors);
  const minOk = checkVersion(m.minVersion, "minVersion", errors);
  if (versionOk && minOk && compareVersions(m.minVersion as string, m.version as string) > 0) errors.push("minVersion: liegt nach version");
  if (!isIso(m.publishedAt)) errors.push("publishedAt: ISO-Zeitpunkt");
  if (m.stableFrom !== null && !isIso(m.stableFrom)) errors.push("stableFrom: ISO-Zeitpunkt oder null");
  if (typeof m.securityRelevant !== "boolean") errors.push("securityRelevant: true oder false");
  checkChanges(m.changes, errors);
  const images = m.images as Record<string, unknown> | undefined;
  for (const role of IMAGE_ROLES) {
    const ref = images?.[role];
    if (typeof ref !== "string" || !IMAGE_REF.test(ref)) errors.push(`images.${role}: Image mit Digest (…@sha256:…)`);
  }
  if (typeof m.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(m.commit)) errors.push("commit: Git-Hash");
  if (m.upstream !== undefined) {
    if (!m.upstream || typeof m.upstream !== "object") errors.push("upstream: Objekt name → Image@sha256:…");
    else
      for (const [name, ref] of Object.entries(m.upstream))
        if (!/^[a-z0-9-]+$/.test(name) || typeof ref !== "string" || !UPSTREAM_REF.test(ref))
          errors.push(`upstream.${name}: Image mit Digest (…@sha256:…)`);
  }
  if (m.files !== undefined) {
    if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) errors.push("files: Objekt Name → SHA-256");
    else
      for (const [name, hash] of Object.entries(m.files))
        if (!(HOST_FILES as readonly string[]).includes(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
          errors.push(`files.${name}: nur ${HOST_FILES.join(", ")} mit SHA-256 (hex)`);
  }
  if (errors.length) throw new Error(`Release-Manifest ungültig:\n- ${errors.join("\n- ")}`);
  return m as unknown as ReleaseManifest;
}

/**
 * Baut das Manifest aus Notizen + Build-Ergebnis. Vorgabe für minVersion: die erste Version der vorigen
 * Minor-Reihe (x.(y-1).0) – so ist ein Release nur von der direkt vorigen Minor-Version aus erreichbar.
 * Vorabversionen (1.5.0-rc.1) werden nie stabil.
 */
export function buildManifest(input: {
  version: string;
  notes: ReleaseNotes;
  images: Record<ImageRole, string>;
  commit: string;
  publishedAt: Date;
  upstream?: Record<string, string>;
  files?: Partial<Record<HostFile, string>>;
}): ReleaseManifest {
  const v = parseVersion(input.version);
  const betaDays = input.notes.betaDays ?? BETA_DAYS;
  const manifest: ReleaseManifest = {
    schema: MANIFEST_SCHEMA,
    version: formatVersion(v),
    publishedAt: input.publishedAt.toISOString(),
    stableFrom: v.prerelease.length ? null : new Date(input.publishedAt.getTime() + betaDays * 86_400_000).toISOString(),
    minVersion: input.notes.minVersion ?? defaultMinVersion(v),
    securityRelevant: input.notes.securityRelevant ?? input.notes.changes.some((c) => c.kind === "sicherheit"),
    changes: input.notes.changes,
    images: input.images,
    commit: input.commit,
    ...(input.upstream && Object.keys(input.upstream).length ? { upstream: input.upstream } : {}),
    ...(input.files && Object.keys(input.files).length ? { files: input.files } : {}),
  };
  return validateManifest(manifest);
}

/**
 * Fremd-Images aus Dockerfiles (`ARG …_IMAGE=ref`) und Compose-Dateien (`image: ref`) sammeln – eigene Images
 * (`${…}`) zählen nicht. Name = letzter Pfadteil ohne Tag (node, restic, caddy, postgres, rest-server).
 * Dasselbe Image in zwei Versionen wäre beim Neubau nicht eindeutig → Fehler.
 */
export function upstreamRefs(sources: string[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const text of sources)
    for (const m of text.matchAll(/^\s*(?:ARG\s+\w+_IMAGE=|image:\s*)(\S+)\s*$/gm)) {
      let ref = m[1]!.replace(/^["']|["']$/g, "");
      // ${SCHULOS_CADDY_IMAGE:-caddy:2} → Vorgabe zählt; eigene Images (${SCHULOS_IMAGE:-schulos:dev}) nicht
      const def = /^\$\{\w+:-(.+)\}$/.exec(ref);
      if (def) ref = def[1]!;
      if (ref.includes("${") || /^schulos(-[a-z]+)?:/.test(ref)) continue;
      const name = ref.split("@")[0]!.split(":")[0]!.split("/").at(-1)!;
      if (refs[name] && refs[name] !== ref) throw new Error(`Fremd-Image ${name} in zwei Versionen: ${refs[name]} und ${ref}`);
      refs[name] = ref;
    }
  return refs;
}

/** Pin-Datei der Fremd-Images (B-47), Pfad relativ zum Repo */
export const UPSTREAM_PINS_FILE = "deploy/upstream/Dockerfile";

/** `FROM <name:tag>@sha256:… AS <schlüssel>` je Zeile → { schlüssel: ref@digest } */
export function parsePins(text: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const m of text.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/gim)) {
    const [, ref, key] = m as unknown as [string, string, string];
    if (!UPSTREAM_REF.test(ref)) throw new Error(`Pin ${key} ohne Tag und Digest: ${ref}`);
    if (pins[key]) throw new Error(`Pin ${key} doppelt`);
    pins[key] = ref;
  }
  return pins;
}

/**
 * Fremd-Images aus Dockerfiles/Compose (Tags, {@link upstreamRefs}) mit den Digests der Pin-Datei versehen. Jeder Tag
 * muss genau so gepinnt sein – sonst hat Dependabot einen Tag angehoben, den die Vorgaben noch nicht kennen (oder umgekehrt).
 */
export function pinUpstream(refs: Record<string, string>, pins: Record<string, string>): Record<string, string> {
  const byTag = new Map(Object.values(pins).map((p) => [p.split("@")[0]!, p]));
  return Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => {
      const tag = ref.split("@")[0]!;
      const pin = byTag.get(tag);
      if (!pin) throw new Error(`Fremd-Image ${tag} (${name}) nicht in ${UPSTREAM_PINS_FILE} gepinnt – Tag dort und in den Vorgaben angleichen`);
      return [name, pin];
    }),
  );
}

/** Beta-Zeit automatischer Patch-Releases (nur neue Fremd-Images, kein eigener Code) – kürzer als bei Funktionen. */
export const AUTO_PATCH_BETA_DAYS = 3;

export function nextPatch(version: string): string {
  const v = parseVersion(version);
  if (v.prerelease.length) throw new Error(`Kein Patch-Release auf eine Vorabversion (${version})`);
  return formatVersion({ ...v, patch: v.patch + 1, prerelease: [] });
}

/** Neuestes fertiges Release (ohne Vorabversionen) – Basis für den wöchentlichen Neubau. */
export function latestFinal(versions: string[]): string | null {
  const finals = versions.filter((s) => {
    try {
      return parseVersion(s).prerelease.length === 0;
    } catch {
      return false;
    }
  });
  return finals.sort(compareVersions).at(-1) ?? null;
}

/**
 * Welche Fremd-Images haben sich seit dem Release geändert? Vergleicht nur die Digests. Fehlt `upstream` im
 * Release (vor B-30), gilt alles als geändert – einmal neu bauen schadet nicht, danach ist der Stand bekannt.
 * Neue oder entfallene Namen zählen als Änderung (anderer Stack).
 */
export function changedUpstream(recorded: Record<string, string> | undefined, current: Record<string, string>): string[] {
  if (!recorded) return Object.keys(current).sort();
  const names = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...names].filter((n) => recorded[n] !== current[n]).sort();
}

const UPSTREAM_LABEL: Record<string, string> = {
  node: "Node.js",
  restic: "restic",
  caddy: "Caddy",
  postgres: "PostgreSQL",
  "rest-server": "rest-server",
};

/** Notizen für ein automatisches Patch-Release (keine Datei in release/notes nötig). */
export function autoPatchNotes(changed: string[]): ReleaseNotes {
  const parts = changed.map((n) => UPSTREAM_LABEL[n] ?? n);
  return {
    betaDays: AUTO_PATCH_BETA_DAYS,
    securityRelevant: true,
    changes: [
      {
        kind: "sicherheit",
        text: `Aktuelle Sicherheitsupdates der Grundbausteine (${parts.join(", ")}) – keine neuen Funktionen`,
      },
    ],
  };
}

function defaultMinVersion(v: Version): string {
  if (v.minor > 0) return `${v.major}.${v.minor - 1}.0`;
  // x.0.0: von der letzten Minor-Reihe der vorigen Major-Version – ohne Kenntnis der Reihe: jede x-1.*
  return v.major > 0 ? `${v.major - 1}.0.0` : "0.0.0";
}

/** Kanal eines Releases zum Zeitpunkt now: stabil ab stableFrom, vorher beta. */
export function channelOf(m: Pick<ReleaseManifest, "stableFrom">, now = new Date()): Channel {
  return m.stableFrom !== null && now.getTime() >= Date.parse(m.stableFrom) ? "stabil" : "beta";
}

/** Sieht eine Instanz im Kanal `channel` dieses Release? (beta sieht alles, stabil nur stabile) */
export function visibleIn(m: Pick<ReleaseManifest, "stableFrom">, channel: Channel, now = new Date()): boolean {
  return channel === "beta" || channelOf(m, now) === "stabil";
}

export type UpdatePlan =
  | { status: "aktuell"; steps: [] }
  | { status: "verfügbar"; steps: ReleaseManifest[]; kind: UpdateKind; securityRelevant: boolean }
  | { status: "blockiert"; steps: []; reason: string };

/**
 * Update-Weg von `current` zur neuesten im Kanal sichtbaren Version. Zwischenversionen werden eingefügt,
 * wenn das Ziel nicht direkt erreichbar ist (minVersion): je Schritt das neueste Release, das von der
 * aktuellen Version aus direkt erreichbar ist. kind = größte Sprungart über alle Schritte.
 */
export function planUpdate(current: string, releases: ReleaseManifest[], channel: Channel, now = new Date()): UpdatePlan {
  const candidates = releases
    .filter((r) => visibleIn(r, channel, now) && compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  if (!candidates.length) return { status: "aktuell", steps: [] };
  const target = candidates[candidates.length - 1]!;
  const steps: ReleaseManifest[] = [];
  let at = current;
  while (compareVersions(at, target.version) < 0) {
    const reachable = candidates.filter((r) => compareVersions(r.version, at) > 0 && compareVersions(r.minVersion, at) <= 0);
    const next = reachable[reachable.length - 1];
    if (!next)
      return {
        status: "blockiert",
        steps: [],
        reason: `Von ${at} führt kein Weg zu ${target.version}: Eine Zwischenversion fehlt im Kanal ${channel}.`,
      };
    steps.push(next);
    at = next.version;
  }
  const order: UpdateKind[] = ["patch", "minor", "major"];
  let kind: UpdateKind = "patch";
  let from = current;
  for (const s of steps) {
    const k = updateKind(from, s.version);
    if (order.indexOf(k) > order.indexOf(kind)) kind = k;
    from = s.version;
  }
  // auch übersprungene Zwischenversionen zählen: ihre Korrekturen stecken im Ziel
  return { status: "verfügbar", steps, kind, securityRelevant: candidates.some((s) => s.securityRelevant) };
}

/**
 * Prüft eine cosign-Signatur (`cosign sign-blob --output-signature`, Base64) über die Manifest-Bytes mit dem
 * öffentlichen Schlüssel (PEM). Die Bytes so prüfen, wie sie geladen wurden – nicht neu serialisieren.
 */
export function verifyManifestSignature(data: Uint8Array, signatureBase64: string, publicKeyPem: string): boolean {
  const sig = Buffer.from(signatureBase64.trim(), "base64");
  if (!sig.length) return false;
  try {
    return verify("sha256", data, publicKeyPem, sig);
  } catch {
    return false;
  }
}

/** Signatur prüfen, dann parsen und validieren – Reihenfolge ist Absicht (nichts Unsigniertes interpretieren). */
export function loadSignedManifest(data: Uint8Array, signatureBase64: string, publicKeyPem: string): ReleaseManifest {
  if (!verifyManifestSignature(data, signatureBase64, publicKeyPem))
    throw new Error("Signatur des Release-Manifests ist ungültig – Update abgebrochen");
  return validateManifest(JSON.parse(Buffer.from(data).toString("utf8")));
}

/** Text für das GitHub-Release und die Änderungsliste in Verwaltung → System. */
export function releaseNotesMarkdown(m: ReleaseManifest): string {
  const lines = [`## SchulOS ${m.version}`, ""];
  if (m.securityRelevant) lines.push("**Sicherheitsrelevant** – bitte zeitnah einspielen.", "");
  for (const kind of CHANGE_KINDS) {
    const items = m.changes.filter((c) => c.kind === kind);
    if (!items.length) continue;
    lines.push(`### ${CHANGE_LABEL[kind]}`, ...items.map((c) => `- ${c.text}`), "");
  }
  const stable = m.stableFrom ? `ab ${m.stableFrom.slice(0, 10)} im Kanal stabil` : "Vorabversion, nur im Kanal beta";
  lines.push(`Kanal: beta, ${stable}. Direkt erreichbar ab Version ${m.minVersion}.`, "", "Images:");
  for (const role of IMAGE_ROLES) lines.push(`- ${role}: \`${m.images[role]}\``);
  return lines.join("\n") + "\n";
}

/** Ein Image für die Release-ISO (B-49): per Digest ziehen, unter `tag` ins Archiv `<file>.tar.gz` */
export interface IsoImage {
  file: string;
  ref: string;
  tag: string;
  /** eigenes Image – cosign-Signatur prüfen */
  signed: boolean;
}

/** Fremd-Images, die im Stack mitlaufen (Archive auf dem Medium); Basis-Images (node, restic) stecken in den eigenen */
export const ISO_UPSTREAM = ["caddy", "postgres", "rest-server"] as const;

/**
 * Images einer Release-ISO aus dem (geprüften) Manifest: die drei eigenen unter `<repo>:<version>`, die Fremd-Images
 * unter ihrem Tag (compose.backup.yaml nennt sie ohne Variable). `env` = images.env auf dem Medium.
 */
export function isoImages(m: ReleaseManifest): { images: IsoImage[]; env: Record<string, string> } {
  const repo = (ref: string) => ref.split("@")[0]!;
  const own = (file: string, ref: string): IsoImage => ({ file, ref, tag: `${repo(ref)}:${m.version}`, signed: true });
  const images = [own("schulos", m.images.app), own("schulos-agent", m.images.agent), own("schulos-backup", m.images.backup)];
  for (const name of ISO_UPSTREAM) {
    const ref = m.upstream?.[name];
    if (!ref) throw new Error(`Release ${m.version} nennt kein Fremd-Image „${name}“ (upstream) – zu alt für eine Release-ISO`);
    if (!/^[^@]+:[^@/]+@/.test(ref)) throw new Error(`upstream.${name}: Tag fehlt (${ref})`);
    images.push({ file: name, ref, tag: repo(ref), signed: false });
  }
  const tag = (file: string) => images.find((i) => i.file === file)!.tag;
  const env: Record<string, string> = {
    SCHULOS_IMAGE: tag("schulos"),
    SCHULOS_AGENT_IMAGE: tag("schulos-agent"),
    SCHULOS_BACKUP_IMAGE: tag("schulos-backup"),
    SCHULOS_CADDY_IMAGE: tag("caddy"),
    SCHULOS_POSTGRES_IMAGE: tag("postgres"),
    SCHULOS_REST_IMAGE: tag("rest-server"),
    // G4E-O10: Profil-Images (nicht auf dem Medium, aus dem Internet) gleich per Digest aus dem signierten Manifest
    ...profileImageEnv(m),
  };
  return { images, env };
}

/**
 * G4E-O10: optionale Profil-Images (ClamAV, CrowdSec, step-ca) – Variable → Name in `upstream`. Ohne diese Variablen zöge
 * `docker compose --profile …` den veränderlichen Tag aus der Compose-Vorgabe (S66).
 */
export const PROFILE_IMAGE_VARS = {
  SCHULOS_CLAMAV_IMAGE: "clamav",
  SCHULOS_CROWDSEC_IMAGE: "crowdsec",
  SCHULOS_STEP_CA_IMAGE: "step-ca",
} as const;

/** Profil-Images per Digest aus dem Manifest (nur, was das Manifest nennt) */
export function profileImageEnv(m: Pick<ReleaseManifest, "upstream">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [v, name] of Object.entries(PROFILE_IMAGE_VARS)) {
    const ref = m.upstream?.[name];
    if (ref && /^[^@\s]+:[^@/\s]+@sha256:[0-9a-f]{64}$/.test(ref)) out[v] = ref;
  }
  return out;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * SEC-08: Digest, unter dem `docker load` mit containerd-Speicher (so ist Docker im installierten System eingerichtet) ein
 * Image-Archiv ablegt – der erste Eintrag der `index.json` im Archiv (OCI-Layout: von `docker save` ab Docker 25 und vom
 * BuildKit-Export `type=docker`). Genau ein Eintrag erwartet (ein Image je Archiv).
 */
export function archiveDigest(indexJson: string): string {
  const index = JSON.parse(indexJson) as { manifests?: { digest?: unknown }[] };
  const list = index.manifests ?? [];
  if (list.length !== 1) throw new Error(`index.json: genau ein Image erwartet, gefunden ${list.length}`);
  const d = list[0]!.digest;
  if (typeof d !== "string" || !SHA256.test(d)) throw new Error(`index.json: kein gültiger Digest (${String(d)})`);
  return d;
}

/**
 * SEC-08: images.env der ISO auf Digests umstellen – `name:tag` → `name:tag@sha256:…` (Tag bleibt lesbar und für den
 * PostgreSQL-Major-Vergleich in `schulosctl update` erhalten, maßgeblich ist der Digest). Jede Image-Variable braucht einen
 * Digest aus dem Archiv; Kommentare und andere Zeilen bleiben. Danach sind Tags (Rückweg nach einem Update, demo-reset,
 * `docker compose up` von Hand) nicht mehr sicherheitsrelevant: ein später unter demselben Tag geladenes Image wird nie benutzt.
 */
export function pinImagesEnv(envText: string, digests: ReadonlyMap<string, string>): string {
  const out = envText.split("\n").map((line) => {
    const m = /^(SCHULOS_[A-Z_]*IMAGE)=(.*)$/.exec(line.trim());
    if (!m) return line;
    const [, key, value] = m as unknown as [string, string, string];
    if (value.includes("@")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${key}: ungültiger Digest (${value})`);
      return `${key}=${value}`;
    }
    const d = digests.get(value);
    if (!d) throw new Error(`${key}: kein Digest für ${value} (Archiv fehlt?)`);
    if (!SHA256.test(d)) throw new Error(`${key}: ungültiger Digest ${d}`);
    return `${key}=${value}@${d}`;
  });
  return out.join("\n");
}
