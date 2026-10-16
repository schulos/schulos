// Systemschritte, Teil 2 (B-42): Docker (containerd-Image-Speicher, Daten unter /srv), Node 24 für schulosctl, Compose-Stack
// der Rolle, systemd-Units, Erststart (Images laden, starten, koppeln bzw. wiederherstellen) und der Konsolenstatus mit
// Adresse auf tty1 (kein QR-Code, INST-05). Rein – die Skripte entstehen hier als Text und werden in den Tests geprüft.
import { BACKUP_DIR, MAIN_DIR, type InstallPlan } from "../generate";
import { CONSOLE_FONT_DIR, TERMINUS_SIZES } from "./console-font";
import { inTarget, type Step, type StepOptions } from "./steps";

/** Aufbau der SchulOS-Dateien auf dem Startmedium (ISO-Bau B-44; Tests bauen ihn aus dem Repo nach) */
export const DIST = {
  node: "node",
  ctl: "schulosctl.mjs",
  systemd: "systemd",
  images: "images",
  /** /etc/grub.d-Skripte (Rückweg nach dem Debian-Versionswechsel, B-43) */
  grub: "grub.d",
  /** SCHULOS_IMAGE=… usw. für die Images auf dem Medium – kommt in die .env des Stacks */
  imagesEnv: "images/images.env",
  /** Stückliste der ISO (B-48) – fehlt beim Systemtest ohne ISO */
  stueckliste: "STUECKLISTE.json",
} as const;

/** Stückliste im installierten System: was genau ausgeliefert wurde (Debian-Pakete, Images, Node, Commit) */
export const STUECKLISTE_PATH = "/usr/share/doc/schulos/stueckliste.json";

/** Docker samt CLI und Compose-Plugin (Debian 13: 26.1 / 2.26; beide nur „empfohlen“, also ausdrücklich) und AppArmor (der Debian-Kernel hat es an, dockerd braucht dann apparmor_parser) – installiert zusammen mit dem Kernel (steps.ts) */
export const SCHULOS_PACKAGES = ["docker.io", "docker-cli", "docker-compose", "apparmor", "openssh-client"];
export const NODE_DIR = "/opt/schulos-node";
export const IMAGES_DIR = "/srv/schulos-images";
export const FIRSTBOOT_ENV = "/etc/schulos/erststart.env";
export const LIB_DIR = "/usr/local/lib/schulos";
/** Backupserver aus dem Abbild: Kopplungscode für die Konsole (tmpfs, 0600 – weg nach dem Neustart) */
export const PAIRING_CODE_FILE = "/run/schulos-kopplungscode";
/** G4E-O04/O05: Bootmenü-Passwort eines eingerichteten Abbilds für die Konsole (tmpfs, weg nach dem Neustart) */
export const GRUB_PASSWORD_CONSOLE_FILE = "/run/schulos-bootmenue-passwort";
/** Units aus deploy/systemd, die das Hauptsystem einschaltet (Vorschau-Timer läuft leer, solange die Vorschau aus ist) */
export const MAIN_TIMERS = ["schulos-sync.timer", "schulos-wartung.timer", "schulos-vorschau.timer"];

/**
 * Docker: containerd-Image-Speicher (Voraussetzung für das Offline-Bundle, B-36: Image-ID = Manifest-Digest) und alles unter
 * /srv – Volumes (Datenbank, Dateien) gehören zu @srv und damit nicht zum System-Schnappschuss (§5a.1).
 * GATE-4c (SICHERHEIT S35): ohne Userland-Proxy – sonst nimmt docker-proxy IPv6-Verbindungen an und reicht sie per IPv4 mit
 * der Adresse des Bridge-Gateways (privat → „Schulnetz“) an Caddy weiter. Ohne ihn leitet Docker nur per iptables weiter
 * (IPv4, echte Absenderadresse); IPv6 von außen wird abgewiesen, solange `edge` kein IPv6 hat (geschlossen statt offen).
 */
export const DOCKER_DAEMON = {
  features: { "containerd-snapshotter": true },
  "data-root": "/srv/docker",
  "log-driver": "local",
  "live-restore": true,
  "userland-proxy": false,
} as const;

export function dockerDaemonJson(): string {
  return `${JSON.stringify(DOCKER_DAEMON, null, 2)}\n`;
}

export function dockerProxyDropin(proxy: string, noProxy: string[]): string {
  return `[Service]\nEnvironment="HTTP_PROXY=${proxy}" "HTTPS_PROXY=${proxy}" "NO_PROXY=${noProxy.join(",")}"\n`;
}

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** Angaben für den Erststart (0600, wird danach gelöscht): Rolle, Stack, Kopplung bzw. Wiederherstellung */
export function firstbootEnv(plan: InstallPlan): string {
  const lines = [`ROLE=${plan.role}`, `STACK=${plan.stackDir}`];
  if (plan.pairing) lines.push(`PAIR_URL=${q(plan.pairing.url)}`, `PAIR_CODE=${q(plan.pairing.code)}`);
  if (plan.restore) lines.push(`RESTORE=${plan.restore.mode}`);
  if (plan.restore?.mode === "offsite") {
    lines.push(`SCHULOS_RECOVERY_KEY=${q(plan.restore.recoveryKey)}`);
    for (const [k, v] of Object.entries(plan.restore.env)) lines.push(`${k}=${q(v)}`);
  }
  if (plan.offsiteHost) lines.push(`OFFSITE_HOST=${q(plan.offsiteHost.host)}`, `OFFSITE_PORT=${plan.offsiteHost.port}`);
  return lines.join("\n") + "\n";
}

/**
 * Erststart (einmal, danach gelöscht): Images laden, Stack starten; Hauptsystem koppeln oder – vor dem ersten Start der App –
 * wiederherstellen. Scheitert die Kopplung, läuft SchulOS trotzdem (Verwaltung → Backup zeigt die rote Warnung); scheitert
 * eine Wiederherstellung, bleibt die App aus und die Konsole zeigt den Fehler – nichts wird halb gestartet.
 */
export function firstbootScript(): string {
  return `#!/bin/bash
# SchulOS – Erststart (vom Installer angelegt, läuft einmal: schulos-erststart.service)
set -euo pipefail
exec > >(tee -a /var/log/schulos-erststart.log) 2>&1
set -a; . ${FIRSTBOOT_ENV}; set +a
status() { echo "$1" > /run/schulos-erststart.status; echo "== $1"; }
cd "$STACK"
compose() { docker compose --project-directory "$STACK" "$@"; }
AGENT=(node /opt/schulos-agent/agent.mjs)

status "Images laden"
for t in ${IMAGES_DIR}/*.tar*; do [ -e "$t" ] && docker load --input "$t"; done

keyscan() { # Host-Schlüssel des SFTP-Offsite-Ziels (beim ersten Kontakt übernommen, Fingerabdruck im Protokoll)
  ssh-keyscan -p "$OFFSITE_PORT" "$OFFSITE_HOST" 2>/dev/null > "$1"
  [ -s "$1" ] || { status "Offsite-Ziel $OFFSITE_HOST nicht erreichbar"; return 1; }
  ssh-keygen -lf "$1" || true
}

if [ "$ROLE" = backup ]; then
  status "SchulOS Backup starten"
  compose up -d --wait
  if [ -n "\${OFFSITE_HOST:-}" ]; then
    keyscan /etc/schulos/offsite_known_hosts && compose cp /etc/schulos/offsite_known_hosts backup:/srv/schulos-backup/config/offsite_known_hosts || true
  fi
else
  case "\${RESTORE:-}" in
    backup)
      status "Datenbank starten"; compose up -d --wait postgres
      status "Mit dem Backupserver koppeln (Ersatz-Kopplung)"; compose run --rm -T backup-agent "\${AGENT[@]}" koppeln "$PAIR_URL" "$PAIR_CODE"
      status "Neuesten Stand wiederherstellen"; compose run --rm -T backup-agent "\${AGENT[@]}" wiederherstellen
      ;;
    offsite)
      status "Datenbank starten"; compose up -d --wait postgres
      extra=()
      if [ -n "\${OFFSITE_HOST:-}" ]; then keyscan /etc/schulos/offsite_known_hosts; extra=(-v /etc/schulos/offsite_known_hosts:/run/offsite_known_hosts:ro); fi
      env_args=(); for v in $(compgen -e | grep -E '^(RCLONE_CONFIG_OFFSITE_|SCHULOS_OFFSITE$|SCHULOS_RECOVERY_KEY$)'); do env_args+=(-e "$v"); done
      status "Neuesten Stand aus der Offsite-Kopie wiederherstellen"
      compose run --rm -T "\${extra[@]}" "\${env_args[@]}" backup-agent "\${AGENT[@]}" wiederherstellen-offsite
      ;;
  esac
  status "SchulOS starten"
  compose up -d --wait
  if [ -z "\${RESTORE:-}" ] && [ -n "\${PAIR_URL:-}" ]; then
    status "Mit dem Backupserver koppeln"
    compose run --rm -T backup-agent "\${AGENT[@]}" koppeln "$PAIR_URL" "$PAIR_CODE" || echo "Kopplung fehlgeschlagen – in Verwaltung → Backup nachholen"
  fi
fi

rm -f ${FIRSTBOOT_ENV}
rm -rf ${IMAGES_DIR}
status "fertig"
`;
}

export function firstbootUnit(): string {
  return `# SchulOS – Erststart: Images laden, starten, koppeln bzw. wiederherstellen (einmal; danach fehlt erststart.env)
[Unit]
Description=SchulOS: Erststart
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=${FIRSTBOOT_ENV}

[Service]
Type=oneshot
ExecStart=${LIB_DIR}/erststart.sh
RemainAfterExit=yes
TimeoutStartSec=2h

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Konsolenstatus auf tty1 (§1 Schritt 4): Adresse, Zustand, letztes Backup bzw. Hinweis zum Kopplungscode (Backupserver). Anmelden: Enter auf tty1 (agetty,
 * normales Passwort, kein Autologin) oder Strg+Alt+F2 (tty2). Rein lesend – Zustand über docker compose und die Statusdatei des Erststarts.
 */
export function consoleScript(plan: InstallPlan, domain: string): string {
  const url = `https://${domain}`;
  const title = plan.role === "backup" ? "SchulOS Backup" : "SchulOS";
  const FONT_SIZES = [...TERMINUS_SIZES].sort((a, b) => b.height - a.height).map((s) => `${s.width}x${s.height}`).join(" ");
  return `#!/bin/bash
# SchulOS – Konsolenstatus (tty1), alle 30 s neu; Enter = Anmeldung
FONT_DIR=${CONSOLE_FONT_DIR}
STACK=${q(plan.stackDir)}
URL=${q(url)}
# UTF-8-Modus der VT (sonst „Â·“ statt „·“) und SchulOS-Schrift in der Größe, die den Bildschirm nutzt; fehlt sie, bleibt die
# Standardschrift. Vor jedem Zeichnen neu laden (INST-05): setupcon (console-setup.service, udev) kann sie nach unserem Start ersetzen.
# Kein QR-Code (INST-05): ohne passende Schrift erschienen ◆ statt Halbblöcken – die Adresse steht als Text da.
pick_font() {
  local size px w h cw ch want
  px=$(cat /sys/class/graphics/fb0/virtual_size 2>/dev/null) || px=
  w=\${px%%,*}; h=\${px##*,}
  case "$w$h" in ''|*[!0-9]*) echo "8x16"; return;; esac
  for want in "100 30" "80 25"; do
    for size in ${FONT_SIZES}; do
      cw=\${size%%x*}; ch=\${size##*x}
      if [ $((w / cw)) -ge \${want% *} ] && [ $((h / ch)) -ge \${want#* } ]; then echo "$size"; return; fi
    done
  done
  echo "8x16"
}
load_font() {
  printf '\\033%%G'
  [ -d "$FONT_DIR" ] && command -v setfont >/dev/null 2>&1 || return 1
  setfont -C /dev/tty1 "$FONT_DIR/schulos-$(pick_font).psf" 2>/dev/null || setfont -C /dev/tty1 "$FONT_DIR/schulos-8x16.psf" 2>/dev/null
}
while true; do
  load_font
  clear
  echo
  echo "  ${title} · $(hostname)"
  echo
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "  Web-Oberfläche:  $URL"
  [ -n "$ip" ] && echo "                   https://$ip (per IP, Zertifikatswarnung bestätigen)"
  if [ -f /run/schulos-erststart.status ] && [ "$(cat /run/schulos-erststart.status)" != fertig ]; then
    echo "  Zustand:  Erststart – $(cat /run/schulos-erststart.status)"
  else
    total=$(docker compose --project-directory "$STACK" config --services 2>/dev/null | wc -l)
    up=$(docker compose --project-directory "$STACK" ps --status running --quiet 2>/dev/null | wc -l)
    if [ "$total" -gt 0 ] && [ "$up" -ge "$total" ]; then echo "  Zustand:  läuft ($up/$total Dienste)"; else echo "  Zustand:  ACHTUNG – $up von $total Diensten laufen"; fi
  fi
  # eingerichtetes Abbild (G4E-O04/O05): Bootmenü-Passwort bis zum nächsten Neustart zeigen – die ISO zeigt es am Ende der Installation
  [ -s ${GRUB_PASSWORD_CONSOLE_FILE} ] && echo "  Bootmenü-Passwort (GRUB, Benutzer schulos; aufschreiben, nur bis zum Neustart sichtbar): $(cat ${GRUB_PASSWORD_CONSOLE_FILE})"
${
  plan.role === "main"
    ? `  last=$(docker compose --project-directory "$STACK" exec -T backup-agent cat /srv/schulos/config/backup-agent-state.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const t=j.lastOkAt;console.log(t?new Date(t).toLocaleString("de-DE"):"–")}catch{console.log("–")}})' 2>/dev/null)
  echo "  Letztes Backup: \${last:-–}"
`
    : `  # eingerichtetes Abbild (B-46): Kopplungscode bis zum nächsten Neustart zeigen – die Installation von der ISO zeigt ihn am Ende
  [ -s ${PAIRING_CODE_FILE} ] && echo "  Kopplungscode für das Hauptsystem (24 h gültig): $(cat ${PAIRING_CODE_FILE})"
  echo
  echo "  Hauptsystem koppeln: Web-Oberfläche oben im Browser öffnen, als Admin anmelden,"
  echo "  dann unter „Instanzen“ → „Kopplungscode erzeugen“ – den Code fragt der Installer des Hauptsystems."
`
}  echo
  echo "  Enter drücken zum Anmelden (Wartungskonto schulos-admin) · alternativ Strg+Alt+F2"
  echo "  Befehle nach der Anmeldung: schulosctl status"
  # Enter → Anmeldung; nach dem Abmelden startet systemd dieses Skript neu (Restart=always) und der Status ist wieder da.
  # Ohne Taste nach 30 s neu zeichnen; liefert read sofort einen Fehler (kein Terminal), nicht in eine Schleife rasen.
  if read -r -s -t 30 _; then
    exec /sbin/agetty --noclear --timeout 120 tty1 linux
  elif [ $? -le 128 ]; then
    sleep 30
  fi
done
`;
}

export function consoleUnit(): string {
  return `# SchulOS – Konsolenstatus auf tty1 statt Anmeldung (Enter startet agetty/login auf tty1, tty2 hat die normale Anmeldung)
[Unit]
Description=SchulOS: Konsolenstatus
After=docker.service schulos-erststart.service
Conflicts=getty@tty1.service

[Service]
ExecStart=${LIB_DIR}/konsole.sh
StandardInput=tty
StandardOutput=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`;
}

const run = (title: string, argv: string[], extra: Partial<Extract<Step, { kind: "run" }>> = {}): Step => ({ kind: "run", title, argv, ...extra });
const write = (title: string, path: string, content: string, mode = 0o644): Step => ({ kind: "write", title, path, content, mode });

export type Role = InstallPlan["role"];

/** Stack je Rolle – steht ohne Antworten fest (Abbild, B-46) */
export function roleStack(role: Role): Pick<InstallPlan, "stackDir" | "composeSource"> {
  return role === "main" ? { stackDir: MAIN_DIR, composeSource: "compose.yaml" } : { stackDir: BACKUP_DIR, composeSource: "compose.backup.yaml" };
}

/** SCHULOS_IMAGE=… usw. im neuen System – beim Einrichten an die .env aus den Antworten angehängt */
export const IMAGES_ENV = `${LIB_DIR}/images.env`;

/** Domain aus der .env des Plans (Konsole, Docker-Proxy) */
export function planDomain(plan: InstallPlan): string {
  const env = plan.files.find((f) => f.path.endsWith("/.env"))?.content ?? "";
  return /^SCHULOS(?:_BACKUP)?_DOMAIN=(.+)$/m.exec(env)?.[1] ?? "localhost";
}

/** Was nur von der Rolle abhängt: Docker, Node 24, Stack-Dateien, schulosctl und Timer, Images, Erststart- und Konsolendienst. */
export function schulosImageSteps(role: Role, o: StepOptions & { dist: string }): Step[] {
  const t = o.target;
  const d = o.dist;
  const { stackDir, composeSource } = roleStack(role);
  const chroot = (title: string, argv: string[]) => inTarget(t, title, argv);
  return [
    write("Docker einrichten", `${t}/etc/docker/daemon.json`, dockerDaemonJson()),
    chroot("Wartungskonto darf Docker steuern", ["usermod", "--append", "--groups", "docker", "schulos-admin"]),
    // Node 24 vom Startmedium (Debian 13 hat Node 20) – für schulosctl und die Konsole
    run("Node.js 24 kopieren", ["cp", "-a", `${d}/${DIST.node}`, `${t}${NODE_DIR}`]),
    run("Node.js verlinken", ["ln", "-sf", `${NODE_DIR}/bin/node`, `${t}/usr/bin/node`]),
    // Stack der Rolle: Compose-Datei, Images-Angaben (die .env selbst entsteht aus den Antworten)
    run("Installationsordner", ["install", "-d", "-m", "0750", `${t}${stackDir}`]),
    run("Compose-Datei", ["cp", `${d}/${composeSource}`, `${t}${stackDir}/compose.yaml`]),
    run("Image-Angaben", ["install", "-D", "-m", "0644", `${d}/${DIST.imagesEnv}`, `${t}${IMAGES_ENV}`]),
    run("Stückliste", ["sh", "-c", `[ ! -f "$1" ] || install -D -m 0644 "$1" "$2"`, "sh", `${d}/${DIST.stueckliste}`, `${t}${STUECKLISTE_PATH}`]),
    ...(role === "main"
      ? [
          run("schulosctl", ["install", "-m", "0755", `${d}/${DIST.ctl}`, `${t}${stackDir}/schulosctl.mjs`]),
          write("schulosctl-Befehl", `${t}/usr/local/bin/schulosctl`, `#!/bin/sh\nexec /usr/bin/node ${stackDir}/schulosctl.mjs --dir ${stackDir} "$@"\n`, 0o755),
          run("systemd-Units für Updates und Abgleich", ["sh", "-c", `cp "$1"/*.service "$1"/*.timer "$2"/`, "sh", `${d}/${DIST.systemd}`, `${t}/etc/systemd/system`]),
          chroot("Timer einschalten", ["systemctl", "enable", ...MAIN_TIMERS]),
        ]
      : []),
    // Images liegen bis zum Erststart unter /srv (dort ist Platz); dockerd läuft in der chroot nicht
    run("Images kopieren", ["install", "-d", "-m", "0700", `${t}${IMAGES_DIR}`]),
    run("Images kopieren", ["sh", "-c", `cp "$1"/*.tar* "$2"/`, "sh", `${d}/${DIST.images}`, `${t}${IMAGES_DIR}`]),
    write("Erststart: Skript", `${t}${LIB_DIR}/erststart.sh`, firstbootScript(), 0o755),
    write("Erststart: Dienst", `${t}/etc/systemd/system/schulos-erststart.service`, firstbootUnit()),
    // Schrift mit Halbblöcken vom Startmedium (INST-02) – fehlt sie (Entwicklung), bleibt die Standardschrift
    run("Konsolenschrift", ["sh", "-c", '[ ! -d "$1" ] || { install -d "$2" && cp -a "$1"/. "$2"/; }', "sh", CONSOLE_FONT_DIR, `${t}${CONSOLE_FONT_DIR}`]),
    write("Konsolenstatus: Dienst", `${t}/etc/systemd/system/schulos-konsole.service`, consoleUnit()),
    // der Erststart läuft nur, wenn es erststart.env gibt (schulosConfigSteps)
    chroot("Dienste einschalten", ["systemctl", "enable", "docker", "schulos-erststart.service", "schulos-konsole.service"]),
    // tty2 = Anmeldung per Strg+Alt+F2 (logind startet sie sonst nur bei Bedarf)
    chroot("Anmeldung auf tty2", ["systemctl", "enable", "getty@tty2.service"]),
  ];
}

/** Was aus den Antworten kommt: Proxy für Docker, .env/schulos.env bzw. backup.env, Erststart-Angaben, Konsole mit Adresse. */
export function schulosConfigSteps(plan: InstallPlan, t: string): Step[] {
  const proxy = typeof plan.system["network.proxy"] === "string" ? (plan.system["network.proxy"] as string) : "";
  const domain = planDomain(plan);
  return [
    ...(proxy ? [write("Proxy für Docker", `${t}/etc/systemd/system/docker.service.d/proxy.conf`, dockerProxyDropin(proxy, ["localhost", "127.0.0.1", domain]))] : []),
    ...plan.files.map((f) => write(`Konfiguration ${f.path}`, `${t}${f.path}`, f.content, f.mode)),
    run("Image-Angaben in die .env", ["sh", "-c", `cat "$1" >> "$2"`, "sh", `${t}${IMAGES_ENV}`, `${t}${plan.stackDir}/.env`]),
    write("Erststart: Angaben", `${t}${FIRSTBOOT_ENV}`, firstbootEnv(plan), 0o600),
    write("Konsolenstatus: Skript", `${t}${LIB_DIR}/konsole.sh`, consoleScript(plan, domain), 0o755),
  ];
}

export function schulosSteps(plan: InstallPlan, o: StepOptions & { dist: string }): Step[] {
  return [...schulosImageSteps(plan.role, o), ...schulosConfigSteps(plan, o.target)];
}
