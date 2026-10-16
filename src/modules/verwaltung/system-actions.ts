"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/core/auth/session";
import { getDb } from "@/core/db/client";
import { placeOrder, SystemOrderError } from "@/core/system/status";
import { alarmRecipients, mailConfig, smtpSender } from "@schulos/server/mail";
import { AlarmSettingsError, readAlarmSettings, saveAlarmSettings } from "@/core/system/security-alarms";
import { enqueueMail, sendNow } from "@/core/mail";
import { testMail } from "@/core/mail-templates";
import { audit } from "@/core/audit";
import { ackDisclaimer } from "@/core/disclaimer";
import { readSchoolSettings } from "@/core/settings";

export interface SystemOrderState {
  ok?: string;
  error?: string;
}

/** Update freigeben – sofort oder im nächsten Wartungsfenster. Der Host holt den Auftrag beim nächsten Abgleich ab. */
export async function releaseUpdateAction(_prev: SystemOrderState, form: FormData): Promise<SystemOrderState> {
  const { user } = await requirePermission("verwaltung.system");
  const target = String(form.get("target") ?? "");
  const when = form.get("wann") === "jetzt" ? "jetzt" : "wartungsfenster";
  try {
    await placeOrder(await getDb(), user.id, { action: "freigabe", target, when });
  } catch (err) {
    if (err instanceof SystemOrderError) return { error: err.message };
    throw err;
  }
  revalidatePath("/verwaltung/system");
  return {
    ok:
      when === "jetzt"
        ? `SchulOS ${target} ist freigegeben – das Update beginnt in wenigen Minuten (vorher Sicherung und Probelauf).`
        : `SchulOS ${target} ist freigegeben – das Update läuft im nächsten Wartungsfenster.`,
  };
}

export async function channelAction(_prev: SystemOrderState, form: FormData): Promise<SystemOrderState> {
  const { user } = await requirePermission("verwaltung.system");
  const channel = form.get("kanal") === "beta" ? "beta" : "stabil";
  await placeOrder(await getDb(), user.id, { action: "kanal", channel });
  revalidatePath("/verwaltung/system");
  return { ok: `Kanal „${channel}“ wird beim nächsten Abgleich übernommen.` };
}

/** Q5-18: Neustart von Hand, wenn er wegen der Passphrase aussteht. Der Host sichert vorher und startet beim nächsten Abgleich neu. */
export async function rebootAction(): Promise<SystemOrderState> {
  const { user } = await requirePermission("verwaltung.system");
  try {
    await placeOrder(await getDb(), user.id, { action: "neustart" });
  } catch (err) {
    if (err instanceof SystemOrderError) return { error: err.message };
    throw err;
  }
  revalidatePath("/verwaltung/system");
  return { ok: "Neustart beauftragt – in wenigen Minuten sichert der Server und startet neu. Danach die Passphrase an der Konsole eingeben." };
}

/** Testmail an die Alarm-Empfänger (B-38) – zeigt, ob SMTP stimmt. Läuft über die Warteschlange wie alle Transaktionsmails (P4-30). */
export async function testMailAction(): Promise<SystemOrderState> {
  const { user } = await requirePermission("verwaltung.system");
  let cfg;
  try {
    cfg = mailConfig(process.env, { alarmTo: false });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!cfg) return { error: "Kein E-Mail-Versand eingerichtet (SCHULOS_SMTP_HOST in schulos.env)." };
  const db = await getDb();
  // SEC-14: Empfänger aus der Umgebung und aus Verwaltung → System
  cfg = { ...cfg, to: alarmRecipients(cfg.to, (await readAlarmSettings(db)).recipients) };
  if (!cfg.to.length) return { error: "Keine Alarm-Empfänger – unten eintragen oder SCHULOS_ALARM_TO in schulos.env." };
  const now = new Date();
  const content = testMail({ school: (await readSchoolSettings(db)).name, now });
  const sender = smtpSender(cfg);
  for (const to of cfg.to) {
    const id = await enqueueMail(db, { to, ...content, purpose: "testmail" }, now);
    const r = await sendNow(db, id, sender, now);
    if (!r.ok) return { error: `Versand fehlgeschlagen: ${r.error} – SchulOS versucht es später erneut.` };
  }
  await audit(db, user.id, "verwaltung.system.testmail", null, { an: cfg.to.length });
  return { ok: `Testnachricht an ${cfg.to.join(", ")} gesendet.` };
}

/** REPO-03: Vorschau-/Haftungshinweis bestätigen (einmal je Fassung, Audit `system.disclaimer.ack`) */
export async function ackDisclaimerAction(): Promise<void> {
  const { user } = await requirePermission("verwaltung.system");
  await ackDisclaimer(await getDb(), user.id);
  revalidatePath("/", "layout");
}

/** SEC-14: zusätzliche Alarm-Empfänger und Schwelle für Fehl-Anmeldungen (je Schule) */
export async function alarmSettingsAction(_prev: SystemOrderState, form: FormData): Promise<SystemOrderState> {
  const { user } = await requirePermission("verwaltung.system");
  try {
    const s = await saveAlarmSettings(await getDb(), user.id, {
      recipients: String(form.get("empfaenger") ?? ""),
      loginThreshold: String(form.get("schwelle") ?? ""),
    });
    revalidatePath("/verwaltung/system");
    return { ok: `Gespeichert: ${s.recipients.length ? s.recipients.join(", ") : "keine zusätzlichen Empfänger"}, Schwelle ${s.loginThreshold} Fehl-Anmeldungen je Stunde.` };
  } catch (err) {
    if (err instanceof AlarmSettingsError) return { error: err.message };
    throw err;
  }
}
