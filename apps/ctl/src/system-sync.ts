// schulosctl system-sync (B-33): Abgleich mit Verwaltung → System über Dateien im Konfigurationsordner – die App hat
// keinen Docker-Socket. Ein systemd-Timer ruft das alle paar Minuten auf: Auftrag der App abholen und ausführen,
// danach den Status (Version, Kanal, verfügbare Updates, Protokoll, Betriebssystem) für die App schreiben.
import type { Channel, ReleaseManifest, UpdatePlan } from "@schulos/server/release";
import type { OsInfo, ProtocolEntry, SystemOrder, SystemStatus } from "@schulos/server/system";

/** Freigabe für das Wartungsfenster (updates/freigabe.json) – B-34 spielt sie im Fenster ein. */
export interface Approval {
  version: string;
  by: string;
  at: string;
}

/** Letzte Protokolleinträge, neueste zuerst; kaputte Zeilen werden übersprungen. */
export function protocolTail(jsonl: string, n = 30): ProtocolEntry[] {
  const out: ProtocolEntry[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ProtocolEntry);
    } catch {
      // halbe Zeile (Absturz beim Schreiben) – ignorieren
    }
  }
  return out.slice(-n).reverse();
}

const releaseView = (m: ReleaseManifest) => ({
  version: m.version,
  publishedAt: m.publishedAt,
  securityRelevant: m.securityRelevant,
  changes: m.changes,
});

export function buildStatus(input: {
  now: Date;
  current: string;
  channel: Channel;
  plan: UpdatePlan | null;
  approved: Approval | null;
  protocol: ProtocolEntry[];
  os: OsInfo | null;
  disk?: SystemStatus["disk"];
  reboot?: RebootPending | null;
  tpm?: SystemStatus["tpm"];
  error?: string;
}): SystemStatus {
  const p = input.plan;
  return {
    version: 1,
    checkedAt: input.now.toISOString(),
    current: input.current,
    channel: input.channel,
    update: !p
      ? null
      : p.status === "aktuell"
        ? { status: "aktuell" }
        : p.status === "blockiert"
          ? { status: "blockiert", reason: p.reason }
          : { status: "verfügbar", kind: p.kind, securityRelevant: p.securityRelevant, steps: p.steps.map(releaseView) },
    // eine Freigabe für eine inzwischen installierte Version ist erledigt
    approved: input.approved && input.approved.version !== input.current ? input.approved : null,
    protocol: input.protocol,
    os: input.os,
    disk: input.disk ?? null,
    reboot: input.reboot ? { since: input.reboot.since, reason: "passphrase" } : null,
    tpm: input.tpm ? { problems: input.tpm.problems.map((p) => p.slice(0, 500)).slice(0, 10) } : null,
    ...(input.error ? { error: input.error } : {}),
  };
}

export type OrderEffect =
  | { kind: "kanal"; channel: Channel; entry: string }
  | { kind: "jetzt"; target: string; entry: string }
  | { kind: "wartungsfenster"; approval: Approval; entry: string }
  | { kind: "neustart"; entry: string }
  | { kind: "verworfen"; entry: string };

/**
 * Was ein Auftrag bewirkt. Eine Freigabe gilt nur für genau die Zielversion, die die Admin gesehen hat – ist
 * inzwischen eine neuere erschienen, wird sie verworfen (die Verwaltung zeigt dann die neue zur Freigabe).
 */
export function orderEffect(order: SystemOrder, plan: UpdatePlan | null, rebootPending = false): OrderEffect {
  if (order.action === "neustart")
    return rebootPending
      ? { kind: "neustart", entry: "Neustart von Hand ausgelöst – danach Passphrase an der Konsole eingeben" }
      : { kind: "verworfen", entry: "Neustart verworfen – es steht keiner aus" };
  if (order.action === "kanal") return { kind: "kanal", channel: order.channel, entry: `Kanal auf „${order.channel}“ gestellt` };
  const target = plan?.status === "verfügbar" ? plan.steps.at(-1)?.version : undefined;
  if (target !== order.target)
    return { kind: "verworfen", entry: `Freigabe für ${order.target} verworfen – verfügbar ist ${target ?? "nichts"}` };
  if (order.when === "jetzt") return { kind: "jetzt", target: order.target, entry: `Update auf ${order.target} freigegeben (sofort)` };
  return {
    kind: "wartungsfenster",
    approval: { version: order.target, by: order.by, at: order.createdAt },
    entry: `Update auf ${order.target} freigegeben (im Wartungsfenster)`,
  };
}

/** Q5-18: ausstehender Neustart bei Passphrase (updates/neustart-noetig.json auf dem Host). */
export interface RebootPending {
  since: string;
}

/**
 * Q5-18: Zustand „Neustart nötig – Passphrase erforderlich“ fortschreiben. Er besteht, solange Debian einen Neustart
 * verlangt und der Start eine Passphrase braucht; `since` bleibt vom ersten Erkennen an stehen (14-Tage-Grenze).
 * `fresh` = gerade neu erkannt (dann einmal ins Protokoll).
 */
export function nextRebootState(
  prev: RebootPending | null,
  input: { required: boolean; passphrase: boolean; now: Date },
): { state: RebootPending | null; fresh: boolean } {
  if (!input.required || !input.passphrase) return { state: null, fresh: false };
  return prev ? { state: prev, fresh: false } : { state: { since: input.now.toISOString() }, fresh: true };
}

export type WindowDecision = { run: false; reason: string } | { run: true; approved: boolean; reason: string };

/**
 * Was im Wartungsfenster passiert (B-34, §5a.2): Patches (nur Fehlerbehebungen/Sicherheit) automatisch, Funktions-
 * Updates nur mit einer Freigabe für genau die verfügbare Zielversion; sonst nichts.
 */
export function windowDecision(plan: UpdatePlan | null, approval: Approval | null): WindowDecision {
  if (!plan) return { run: false, reason: "Updates nicht abrufbar" };
  if (plan.status === "aktuell") return { run: false, reason: "aktuell" };
  if (plan.status === "blockiert") return { run: false, reason: plan.reason };
  const target = plan.steps.at(-1)!.version;
  if (plan.kind === "patch") return { run: true, approved: false, reason: `Patch ${target} automatisch` };
  if (approval?.version === target) return { run: true, approved: true, reason: `${target} freigegeben von ${approval.by}` };
  return { run: false, reason: `${target} wartet auf Freigabe in Verwaltung → System` };
}
