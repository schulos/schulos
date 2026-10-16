"use server";

import { mailConfig, smtpSender, testMessage } from "@schulos/server/mail";
import { audit } from "@/audit";
import { requireUser } from "@/auth/session";
import { getDb } from "@/db/client";
import { serverName } from "@/settings";

export interface TestMailState {
  ok?: string;
  error?: string;
}

/** Testmail an die Alarm-Empfänger (B-38) – zeigt, ob SMTP stimmt. */
export async function testMailAction(): Promise<TestMailState> {
  const user = await requireUser();
  let cfg;
  try {
    cfg = mailConfig();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!cfg) return { error: "Kein E-Mail-Versand eingerichtet (SCHULOS_SMTP_HOST in backup.env)." };
  try {
    await smtpSender(cfg)(testMessage(serverName(), cfg.to));
  } catch (err) {
    return { error: `Versand fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
  await audit(await getDb(), user.id, "system.testmail", null, { an: cfg.to.length });
  return { ok: `Testnachricht an ${cfg.to.join(", ")} gesendet.` };
}
