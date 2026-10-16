// E-Mail (B-38): SMTP-Konfiguration aus der Umgebung (schulos.env bzw. backup.env), Testmail und Alarme – gemeinsam für
// Hauptsystem und Backupserver. Alarme werden je Ursache einmal gemeldet, bei Fortbestehen täglich erinnert und beim
// Verschwinden als „behoben“ gemeldet; den Stand dazwischen merkt sich die jeweilige App (AlarmState).
import { createTransport } from "nodemailer";

export interface MailConfig {
  host: string;
  port: number;
  /** TLS ab Verbindungsbeginn (Port 465); sonst STARTTLS, wenn der Server es anbietet (bei 587 Pflicht) */
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
  /** Empfänger der Alarme */
  to: string[];
}

export type Env = Record<string, string | undefined>;

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Sieht aus wie eine E-Mail-Adresse (einfache Prüfung ohne Anzeigenamen). */
export function isMailAddress(a: string): boolean {
  return ADDRESS.test(a) && a.length <= 254;
}

/**
 * SMTP aus der Umgebung; ohne SCHULOS_SMTP_HOST keine Mails (null). Fehlerhafte Angaben → Error mit Klartext.
 * `alarmTo: false` (Transaktionsmails, P4-30): SCHULOS_ALARM_TO ist dann nicht Pflicht – `to` bleibt ggf. leer.
 */
export function mailConfig(env: Env = process.env, opts: { alarmTo?: boolean } = {}): MailConfig | null {
  const host = env.SCHULOS_SMTP_HOST?.trim();
  if (!host) return null;
  const errors: string[] = [];
  const port = Number(env.SCHULOS_SMTP_PORT ?? "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("SCHULOS_SMTP_PORT: Zahl 1–65535");
  const from = env.SCHULOS_SMTP_FROM?.trim() ?? "";
  if (!ADDRESS.test(from.replace(/^.*<(.+)>$/, "$1"))) errors.push("SCHULOS_SMTP_FROM: Absenderadresse, z. B. schulos@schule.de");
  const to = (env.SCHULOS_ALARM_TO ?? "")
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  if (!to.length && opts.alarmTo !== false) errors.push("SCHULOS_ALARM_TO: mindestens eine Empfängeradresse");
  for (const a of to) if (!ADDRESS.test(a)) errors.push(`SCHULOS_ALARM_TO: „${a}“ ist keine E-Mail-Adresse`);
  if (errors.length) throw new Error(`E-Mail-Einstellungen unvollständig:\n- ${errors.join("\n- ")}`);
  return {
    host,
    port,
    secure: env.SCHULOS_SMTP_SECURE === "1" || port === 465,
    user: env.SCHULOS_SMTP_USER?.trim() || null,
    password: env.SCHULOS_SMTP_PASSWORD ?? null,
    from,
    to,
  };
}

/** Wie mailConfig, aber für Jobs und Alarme: fehlerhafte Angaben werden protokolliert und gelten als „keine Mail“ (null). */
export function safeMailConfig(
  env: Env = process.env,
  log: (msg: string) => void = (m) => console.error(m),
  opts: { alarmTo?: boolean } = {},
): MailConfig | null {
  try {
    return mailConfig(env, opts);
  } catch (err) {
    log(`[schulos] SMTP-Konfiguration fehlerhaft: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
}

export type Sender = (msg: MailMessage) => Promise<void>;

export function smtpSender(cfg: MailConfig): Sender {
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure && cfg.port === 587,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
    connectionTimeout: 15_000,
  });
  return async (msg) => {
    await transport.sendMail({ from: cfg.from, to: msg.to.join(", "), subject: msg.subject, text: msg.text });
  };
}

// ---------- Alarme ----------

export interface Alarm {
  /** stabile Kennung der Ursache, z. B. „backup:lindenhof“ */
  key: string;
  title: string;
  /** Hinweis, was zu tun ist (Alltagssprache) */
  detail: string;
  /**
   * SEC-14: Ereignis statt Zustand (z. B. „Admin-Recht vergeben“) – genau einmal melden, nicht erinnern, kein „behoben“.
   * Die Kennung muss je Ereignis eindeutig sein; solange es aktiv gemeldet wird, bleibt es im Stand (keine Doppelmeldung).
   */
  event?: boolean;
}

export type AlarmState = Record<string, { since: string; lastSentAt: string; title: string; event?: boolean }>;

/** Erinnerung an einen fortbestehenden Alarm nach so vielen Stunden. */
export const REMIND_HOURS = 24;

export interface AlarmPlan {
  /** neu oder zu erinnern */
  send: (Alarm & { reminder: boolean })[];
  resolved: { key: string; title: string }[];
  next: AlarmState;
}

export function planAlarms(active: Alarm[], state: AlarmState, now = new Date()): AlarmPlan {
  const next: AlarmState = {};
  const send: AlarmPlan["send"] = [];
  for (const a of active) {
    const prev = state[a.key];
    const due = !prev || (!a.event && now.getTime() - Date.parse(prev.lastSentAt) >= REMIND_HOURS * 3600_000);
    if (due) send.push({ ...a, reminder: Boolean(prev) });
    next[a.key] = { since: prev?.since ?? now.toISOString(), lastSentAt: due ? now.toISOString() : prev!.lastSentAt, title: a.title, ...(a.event ? { event: true } : {}) };
  }
  // Ereignisse verschwinden still aus dem Stand – „behoben“ gibt es nur für Zustände
  const resolved = Object.entries(state)
    .filter(([key, v]) => !v.event && !active.some((a) => a.key === key))
    .map(([key, v]) => ({ key, title: v.title }));
  return { send, resolved, next };
}

/** Eine Mail für alle neuen/erinnerten bzw. behobenen Alarme eines Durchgangs. */
export function alarmMessage(server: string, plan: Pick<AlarmPlan, "send" | "resolved">, to: string[]): MailMessage | null {
  if (!plan.send.length && !plan.resolved.length) return null;
  const lines: string[] = [];
  if (plan.send.length) {
    lines.push("Bitte kümmern:", "");
    for (const a of plan.send) lines.push(`• ${a.title}${a.reminder ? " (Erinnerung – besteht weiter)" : ""}`, `  ${a.detail}`, "");
  }
  if (plan.resolved.length) {
    lines.push("Wieder in Ordnung:", "");
    for (const r of plan.resolved) lines.push(`• ${r.title}`);
    lines.push("");
  }
  lines.push(`– ${server} (automatische Nachricht, keine Personendaten)`);
  const subject = plan.send.length
    ? `[${server}] ${plan.send.length === 1 ? plan.send[0]!.title : `${plan.send.length} Probleme`}`
    : `[${server}] behoben: ${plan.resolved.map((r) => r.title).join(", ")}`;
  return { to, subject, text: lines.join("\n") };
}

export function testMessage(server: string, to: string[], now = new Date()): MailMessage {
  return {
    to,
    subject: `[${server}] Testnachricht`,
    text: `Diese Testnachricht zeigt, dass ${server} E-Mails versenden kann (${now.toISOString()}).\nAn diese Adresse gehen künftig Alarme: Backup überfällig, Prüfung fehlgeschlagen, Speicherplatz knapp, Update fehlgeschlagen.`,
  };
}

/** Speicherplatz gilt ab diesem Füllstand als knapp. */
export const DISK_WARN_PERCENT = 90;

/** SEC-14: Empfänger aus der Umgebung (SCHULOS_ALARM_TO) und aus der Verwaltung zusammenführen – ohne Doppelte, nur gültige. */
export function alarmRecipients(fromEnv: string[], fromSettings: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of [...fromEnv, ...fromSettings].map((x) => x.trim()).filter(Boolean)) {
    if (!isMailAddress(a) || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}
