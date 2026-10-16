// Debian-Versionswechsel, geführt (B-43, INSTALLATION.md §5a.1): `schulosctl os-upgrade` – Vorbedingungen (frische Sicherung,
// Test-Restore grün, Platz), beschreibbarer Schnappschuss von @ samt /boot-Sicherung, Paketquellen umstellen, full-upgrade,
// Neustart. Nach dem Start prüft `os-upgrade-pruefen` (systemd, einmal): Debian-Version neu und Stack gesund → fertig, sonst
// automatisch zurück auf den Schnappschuss (Subvolume @ tauschen, /boot zurück) und neu starten. Daten in @srv bleiben dabei
// unberührt. Rein bis auf die Schritte in OsDeps (echte in os.ts).
import type { ProtocolEntry } from "@schulos/server/system";

export const CODENAMES = ["bookworm", "trixie", "forky", "duke"] as const;
/** Mindestens frei auf / für den Versionswechsel (Pakete + Schnappschuss) */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;

export function nextCodename(current: string): string | null {
  const i = (CODENAMES as readonly string[]).indexOf(current);
  return i >= 0 && i + 1 < CODENAMES.length ? CODENAMES[i + 1]! : null;
}

/** Paketquellen (deb822 oder sources.list) auf die neue Version: trixie, trixie-updates, trixie-security → forky… */
export function rewriteSources(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`\\b${from}(?=(-updates|-security|-backports)?\\b)`, "g"), to);
}

export interface OsUpgradeMarker {
  from: string;
  to: string;
  /** upgrade = Pakete werden umgestellt · neustart = fertig umgestellt, Prüfung nach dem Start offen · zurueck = Schnappschuss zurückgespielt */
  phase: "upgrade" | "neustart" | "zurueck";
  at: string;
  error?: string;
}

export interface OsDeps {
  now(): Date;
  log(entry: ProtocolEntry): void;
  codename(): Promise<string>;
  freeBytes(): Promise<number>;
  backup(): Promise<void>;
  testRestore(): Promise<{ ok: boolean; error?: string }>;
  /** @ → @snapshots/vor-os-upgrade (beschreibbar) + Sicherung von /boot */
  snapshot(): Promise<void>;
  setSources(from: string, to: string): Promise<void>;
  upgrade(): Promise<void>;
  /** Schnappschuss zurück: @ gegen den Schnappschuss tauschen, /boot zurückspielen (wirkt nach dem Neustart) */
  restore(): Promise<void>;
  reboot(): Promise<void>;
  /** beiseitegelegte Systeme früherer Rückwege (@kaputt-…) löschen – nur, solange keines davon läuft; Anzahl gelöscht */
  removeBroken(): Promise<number>;
  /** wartet, bis Docker und der Stack gesund sind (mit Frist) */
  stackHealthy(): Promise<boolean>;
  marker: { read(): OsUpgradeMarker | null; write(m: OsUpgradeMarker): void; clear(): void };
}

export type OsUpgradeOutcome =
  | { status: "blockiert"; reason: string }
  | { status: "neustart"; from: string; to: string }
  | { status: "fehlgeschlagen"; from: string; to: string; error: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export async function runOsUpgrade(d: OsDeps, opts: { target?: string } = {}): Promise<OsUpgradeOutcome> {
  const at = () => d.now().toISOString();
  const block = (reason: string): OsUpgradeOutcome => {
    d.log({ at: at(), step: "os-upgrade", ok: false, detail: `nicht begonnen: ${reason}` });
    return { status: "blockiert", reason };
  };
  if (d.marker.read()) return block("Ein Versionswechsel ist schon im Gang (Prüfung nach dem Neustart steht aus).");
  const from = await d.codename();
  const to = opts.target ?? nextCodename(from);
  if (!to) return block(`Keine neuere Debian-Version nach „${from}“ bekannt.`);
  if (!CODENAMES.includes(to as never) || CODENAMES.indexOf(to as never) <= CODENAMES.indexOf(from as never))
    return block(`„${to}“ ist keine neuere Version als „${from}“.`);
  if (CODENAMES.indexOf(to as never) - CODENAMES.indexOf(from as never) > 1) return block("Versionen nur einzeln überspringen (Debian unterstützt nur den Wechsel auf die nächste).");
  // Reste früherer Rückwege (je mehrere GB) zuerst weg – sonst sperrt die Platzprüfung irgendwann jeden Versuch
  await cleanup(d, at);
  const free = await d.freeBytes();
  if (free < MIN_FREE_BYTES) return block(`Zu wenig Platz: ${gb(free)} frei, nötig ${gb(MIN_FREE_BYTES)}.`);
  try {
    await d.backup();
  } catch (e) {
    return block(`Sicherung fehlgeschlagen: ${msg(e)}`);
  }
  const probe = await d.testRestore();
  if (!probe.ok) return block(`Test-Restore nicht grün: ${probe.error ?? "?"}`);
  d.log({ at: at(), step: "backup", ok: true, from, to, detail: "Sicherung und Test-Restore vor dem Versionswechsel" });

  await d.snapshot();
  d.marker.write({ from, to, phase: "upgrade", at: at() });
  try {
    await d.setSources(from, to);
    await d.upgrade();
  } catch (e) {
    // halb umgestellt: sofort zurück auf den Schnappschuss
    const error = msg(e);
    await d.restore();
    d.marker.write({ from, to, phase: "zurueck", at: at(), error });
    d.log({ at: at(), step: "os-rueckweg", ok: true, from, to, detail: `Paketumstellung fehlgeschlagen (${error}) – Schnappschuss zurück, Neustart` });
    await d.reboot();
    return { status: "fehlgeschlagen", from, to, error };
  }
  d.marker.write({ from, to, phase: "neustart", at: at() });
  d.log({ at: at(), step: "os-upgrade", ok: true, from, to, detail: "Pakete umgestellt, Neustart – danach Prüfung" });
  await d.reboot();
  return { status: "neustart", from, to };
}

async function cleanup(d: OsDeps, at: () => string): Promise<void> {
  try {
    const n = await d.removeBroken();
    if (n > 0) d.log({ at: at(), step: "os-aufraeumen", ok: true, detail: `${n} beiseitegelegte(s) System(e) früherer Rückwege gelöscht` });
  } catch (e) {
    d.log({ at: at(), step: "os-aufraeumen", ok: false, detail: `Reste früherer Rückwege (@kaputt-…) nicht gelöscht: ${msg(e)}` });
  }
}

export type CheckOutcome = "nichts" | "fertig" | "zurueck" | "zurueck-gemeldet";

/** Nach dem Start (schulos-os-upgrade-pruefen.service): fertig melden oder automatisch zurück. */
export async function checkAfterBoot(d: OsDeps): Promise<CheckOutcome> {
  const m = d.marker.read();
  if (!m) return "nichts";
  const at = () => d.now().toISOString();
  if (m.phase === "zurueck") {
    d.log({ at: at(), step: "os-upgrade", ok: false, from: m.from, to: m.to, detail: `zurückgenommen: ${m.error ?? "?"} – läuft wieder mit ${m.from}` });
    d.marker.clear();
    await cleanup(d, at);
    return "zurueck-gemeldet";
  }
  let error: string | null = null;
  if (m.phase === "upgrade") error = "Umstellung wurde unterbrochen (Stromausfall, Absturz?)";
  else if ((await d.codename()) !== m.to) error = `Nach dem Neustart läuft nicht ${m.to}`;
  else if (!(await d.stackHealthy())) error = "SchulOS ist nach dem Neustart nicht gesund (Docker/Stack/Healthcheck)";
  if (!error) {
    d.log({ at: at(), step: "os-upgrade", ok: true, from: m.from, to: m.to, detail: `fertig: läuft mit ${m.to}, SchulOS gesund` });
    d.marker.clear();
    return "fertig";
  }
  await d.restore();
  d.marker.write({ ...m, phase: "zurueck", at: at(), error });
  d.log({ at: at(), step: "os-rueckweg", ok: true, from: m.from, to: m.to, detail: `${error} – Schnappschuss zurück, Neustart` });
  await d.reboot();
  return "zurueck";
}
