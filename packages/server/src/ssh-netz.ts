// SEC-12 „SSH nur aus dem Schulnetz“ – gemeinsam für den Installer (neue Server) und `schulosctl ssh-netze` (Änderung später,
// G4E-O17): Netze prüfen und normieren (G4E-O06), nftables-Regel, Dienst, sshd-Einstellung und die Bindung von ssh.service an die
// Regel (fail closed). Rein.

/** Vorgabe der Schulnetz-Bereiche: alle privaten Bereiche (enthalten typische WireGuard-Netze) */
export const SSH_PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"] as const;

export const SSH_NET_FILE = "/etc/schulos/ssh-netz.nft";
export const SSH_NET_UNIT = "/etc/systemd/system/schulos-ssh-netz.service";
export const SSHD_CONF_FILE = "/etc/ssh/sshd_config.d/schulos.conf";
/** G4E-O06: ssh.service startet nur, wenn die Firewall-Regel geladen ist */
export const SSH_REQUIRES_DROPIN = "/etc/systemd/system/ssh.service.d/schulos-netz.conf";

interface Parsed {
  v: 4 | 6;
  n: bigint;
}

function parseV4(s: string): bigint | null {
  const parts = s.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => (n << 8n) | BigInt(Number(p)), 0n);
}

function parseV6(s: string): bigint | null {
  if (!/^[0-9a-f:]+$/i.test(s) || !s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function parseAddr(s: string): Parsed | null {
  const v4 = parseV4(s);
  if (v4 !== null) return { v: 4, n: v4 };
  const v6 = parseV6(s.toLowerCase());
  return v6 !== null ? { v: 6, n: v6 } : null;
}

function formatAddr(a: Parsed): string {
  if (a.v === 4) return [24n, 16n, 8n, 0n].map((s) => String((a.n >> s) & 255n)).join(".");
  const groups = Array.from({ length: 8 }, (_, i) => ((a.n >> BigInt(112 - i * 16)) & 0xffffn).toString(16));
  // längste Folge von Nullgruppen (≥ 2) als „::“
  let best = -1;
  let len = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > len && j - i >= 2) {
      best = i;
      len = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + len).join(":")}`;
}

export type NetCheck = { ok: true; net: string } | { ok: false; error: string; suggestion?: string };

/**
 * G4E-O06: Netz (CIDR) bzw. einzelne Adresse prüfen. Gesetzte Host-Bits (`10.10.0.5/24`) sind ein Fehler mit Vorschlag
 * (`10.10.0.0/24`) – OpenSSH lehnt solche Netze in `AllowUsers` ab („Inconsistent mask length“), dann käme niemand mehr per SSH
 * herein. Ohne Präfix gilt die einzelne Adresse.
 */
export function checkNet(raw: string): NetCheck {
  const s = raw.trim();
  const [addr = "", prefix, ...rest] = s.split("/");
  const a = rest.length ? null : parseAddr(addr);
  if (!a) return { ok: false, error: `„${s}“ ist kein Netz wie 10.10.0.0/16 bzw. fd00::/8` };
  const max = a.v === 4 ? 32 : 128;
  if (prefix === undefined) return { ok: true, net: formatAddr(a) };
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return { ok: false, error: `„${s}“: Präfix 0 bis ${max}` };
  const bits = Number(prefix);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  const base = { v: a.v, n: a.n & mask };
  const net = `${formatAddr(base)}/${bits}`;
  if (base.n !== a.n)
    return { ok: false, error: `„${s}“ hat gesetzte Host-Bits – gemeint ist wohl ${net}`, suggestion: net };
  return { ok: true, net };
}

/** Liegt die Adresse in einem der Netze (bereits geprüft)? Für „schneide ich mir gerade die eigene SSH-Sitzung ab?“ */
export function addressInNets(ip: string, nets: readonly string[]): boolean {
  const a = parseAddr(ip.trim().replace(/^::ffff:(?=\d+\.)/i, ""));
  if (!a) return false;
  return nets.some((entry) => {
    const [addr = "", prefix] = entry.split("/");
    const n = parseAddr(addr);
    if (!n || n.v !== a.v) return false;
    const max = n.v === 4 ? 32 : 128;
    const bits = prefix === undefined ? max : Number(prefix);
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
    return (a.n & mask) === (n.n & mask);
  });
}

/** Netze für SSH; null = von überall (0.0.0.0/0 bzw. ::/0 eingetragen) */
export function sshNetList(nets: readonly string[]): string[] | null {
  const list = nets.map((n) => n.trim()).filter(Boolean);
  const effective = list.length ? list : [...SSH_PRIVATE_NETS];
  return effective.some((n) => n === "0.0.0.0/0" || n === "::/0") ? null : effective;
}

/** SSH: nur für das Wartungskonto; mit Schlüssel keine Passwort-Anmeldung; mit Netzen nur von dort (zusätzlich zur Firewall) */
export function sshdConfig(nets: readonly string[] | null, keys: boolean): string {
  const allow = nets ? nets.map((n) => `schulos-admin@${n}`).join(" ") : "schulos-admin";
  return ["# SchulOS", "PermitRootLogin no", `AllowUsers ${allow}`, `PasswordAuthentication ${keys ? "no" : "yes"}`, "KbdInteractiveAuthentication no", ""].join("\n");
}

/** Netze aus einer sshd-Einstellung von SchulOS (AllowUsers schulos-admin@…); null = ohne Einschränkung bzw. keine Zeile */
export function netsFromSshdConfig(text: string): string[] | null {
  const line = text.split(/\r?\n/).find((l) => /^\s*AllowUsers\s/.test(l));
  if (!line) return null;
  const nets = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((u) => /^schulos-admin@(.+)$/.exec(u)?.[1])
    .filter((n): n is string => Boolean(n));
  return nets.length ? nets : null;
}

/** sshd-Einstellung mit neuen Netzen – übrige Zeilen (PasswordAuthentication …) bleiben */
export function withSshdNets(text: string, nets: readonly string[]): string {
  const allow = `AllowUsers ${nets.map((n) => `schulos-admin@${n}`).join(" ")}`;
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*AllowUsers\s/.test(l));
  if (i >= 0) lines[i] = allow;
  else lines.splice(lines[0]?.startsWith("#") ? 1 : 0, 0, allow);
  return lines.join("\n");
}

/**
 * SEC-12: Port 22 nur aus den erlaubten Netzen (eigene nftables-Tabelle, unabhängig von Dockers Regeln; kein `flush ruleset`).
 * Loopback bleibt offen. IPv6 nur, wenn ein IPv6-Netz eingetragen ist.
 */
export function sshNetRules(nets: readonly string[]): string {
  const v4 = nets.filter((n) => !n.includes(":"));
  const v6 = nets.filter((n) => n.includes(":"));
  return [
    "#!/usr/sbin/nft -f",
    "# SchulOS (SEC-12): SSH nur aus dem Schulnetz bzw. über WireGuard – geändert vom Installer bzw. `schulosctl ssh-netze`",
    "table inet schulos_ssh",
    "delete table inet schulos_ssh",
    "table inet schulos_ssh {",
    "  chain input {",
    "    type filter hook input priority filter; policy accept;",
    "    iif lo accept",
    ...(v4.length ? [`    tcp dport 22 ip saddr { ${v4.join(", ")} } accept`] : []),
    ...(v6.length ? [`    tcp dport 22 ip6 saddr { ${v6.join(", ")} } accept`] : []),
    "    tcp dport 22 drop",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** Netze aus der Regel-Datei (für `schulosctl ssh-netze` ohne Argumente) */
export function netsFromRules(text: string): string[] {
  return [...text.matchAll(/saddr \{ ([^}]*) \}/g)].flatMap((m) =>
    m[1]!
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function sshNetUnit(): string {
  return [
    "# SchulOS (SEC-12): Firewall-Regel für SSH – vor dem Netz, damit Port 22 nie ungeschützt offen ist",
    "[Unit]",
    "Description=SchulOS: SSH nur aus dem Schulnetz/WireGuard",
    "DefaultDependencies=no",
    "Before=network-pre.target ssh.service",
    "Wants=network-pre.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=/usr/sbin/nft -f ${SSH_NET_FILE}`,
    "ExecStop=/usr/sbin/nft delete table inet schulos_ssh",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * G4E-O06: fail closed – ssh.service braucht die geladene Regel. Scheitert `nft -f` (Syntax, Versionsunterschied), bleibt sshd
 * aus (die Konsole bleibt), statt ohne Port-Filter zu starten.
 */
export function sshRequiresDropin(): string {
  return [
    "# SchulOS (SEC-12, G4E-O06): sshd nur mit geladener Firewall-Regel – sonst bleibt SSH aus (Konsole geht weiter)",
    "[Unit]",
    "Requires=schulos-ssh-netz.service",
    "After=schulos-ssh-netz.service",
    "",
  ].join("\n");
}
