import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MailMessage } from "@schulos/server/mail";
import type { DbHandle } from "@/core/db/client";
import { mailOutbox } from "@/core/db/schema";
import { createTestDb } from "@/core/db/testing";
import {
  appUrl,
  deliverOutbox,
  deliverWithConfig,
  devMailEnabled,
  enqueueMail,
  listOutbox,
  MAIL_MAX_ATTEMPTS,
  mailAvailable,
  MailInputError,
  outboxStats,
  retryDelayMs,
  scrubError,
  sendNow,
} from "./mail";
import { emailConfirmMail, testMail } from "./mail-templates";

describe("Transaktionsmails – rein", () => {
  it("Wiederholung mit wachsendem Abstand, höchstens 6 Stunden", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(30)).toBe(6 * 3_600_000);
  });

  it("/dev/mail nur in Entwicklung bzw. mit SCHULOS_DEV_MAIL=1, nie produktiv", () => {
    expect(devMailEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(devMailEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(devMailEnabled({ NODE_ENV: "production", SCHULOS_DEV_MAIL: "1" })).toBe(true);
    expect(devMailEnabled({ NODE_ENV: "development", SCHULOS_DEV_MAIL: "1", SCHULOS_INSTANCE: "production" })).toBe(false);
  });

  it("Mail verfügbar: SMTP ohne Alarm-Empfänger genügt; sonst nur Dev/E2E", () => {
    expect(mailAvailable({ NODE_ENV: "production" })).toBe(false);
    expect(mailAvailable({ NODE_ENV: "production", SCHULOS_SMTP_HOST: "smtp.schule.de", SCHULOS_SMTP_FROM: "s@schule.de" })).toBe(true);
    expect(mailAvailable({ NODE_ENV: "production", SCHULOS_DEV_MAIL: "1" })).toBe(true);
  });

  it("Links aus BETTER_AUTH_URL, Fehlertexte ohne Adressen", () => {
    expect(appUrl("/konto/email/abc", { BETTER_AUTH_URL: "https://schulos.schule.de/" })).toBe("https://schulos.schule.de/konto/email/abc");
    expect(scrubError(new Error("550 <eltern@example.org>: user unknown"))).toBe("550 <<adresse>>: user unknown");
  });

  it("Vorlagen: Alltagssprache, Link und Gültigkeit", () => {
    const m = emailConfirmMail({ school: "Lindenhof", name: "Jana Brandt", link: "https://x/konto/email/t", hours: 24 });
    expect(m.subject).toBe("Lindenhof: E-Mail-Adresse bestätigen");
    expect(m.text).toContain("https://x/konto/email/t");
    expect(m.text).toContain("24 Stunden");
    expect(testMail({ school: "Lindenhof", now: new Date(0) }).subject).toBe("[SchulOS Lindenhof] Testnachricht");
  });
});

describe("Transaktionsmails – Warteschlange", () => {
  let h: DbHandle;
  const t0 = new Date("2030-03-01T08:00:00Z");
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.db.delete(mailOutbox);
  });

  const mail = (to = "eltern@example.org") => ({ to, subject: "Betreff\r\nBcc: x@y.de", text: "Hallo", purpose: "test" });

  it("prüft Adresse und Größe, entfernt Zeilenumbrüche aus dem Betreff", async () => {
    await expect(enqueueMail(h.db, mail("kein-mail"))).rejects.toBeInstanceOf(MailInputError);
    await expect(enqueueMail(h.db, { ...mail(), text: "x".repeat(20_001) })).rejects.toThrow(/zu lang/);
    const id = await enqueueMail(h.db, mail(), t0);
    const [row] = await h.db.select().from(mailOutbox).where(eq(mailOutbox.id, id));
    expect(row).toMatchObject({ to: "eltern@example.org", subject: "Betreff Bcc: x@y.de", attempts: 0, sentAt: null });
  });

  it("Versand: einzeln je Empfänger, danach Inhalt geleert (nur Kennzahlen)", async () => {
    await enqueueMail(h.db, mail(), t0);
    await enqueueMail(h.db, mail("zwei@example.org"), t0);
    const sent: MailMessage[] = [];
    const r = await deliverOutbox(h.db, { sender: async (m) => void sent.push(m), now: t0 });
    expect(r).toEqual({ sent: 2, retry: 0, failed: 0 });
    expect(sent.map((m) => m.to)).toEqual([["eltern@example.org"], ["zwei@example.org"]]);
    const rows = await listOutbox(h.db);
    expect(rows.every((x) => x.to === "" && x.subject === "" && x.text === "" && x.sentAt && x.attempts === 1 && x.purpose === "test")).toBe(true);
    // nichts doppelt
    expect(await deliverOutbox(h.db, { sender: async (m) => void sent.push(m), now: t0 })).toEqual({ sent: 0, retry: 0, failed: 0 });
    expect(await outboxStats(h.db)).toMatchObject({ pending: 0, sent: 2, failed: 0, oldestPending: null });
  });

  it("Fehler: später erneut (wachsender Abstand), nach MAIL_MAX_ATTEMPTS endgültig gescheitert und geleert", async () => {
    const id = await enqueueMail(h.db, mail(), t0);
    const failing = async () => {
      throw new Error("421 eltern@example.org try later");
    };
    let now = t0;
    expect(await deliverOutbox(h.db, { sender: failing, now })).toEqual({ sent: 0, retry: 1, failed: 0 });
    let [row] = await h.db.select().from(mailOutbox).where(eq(mailOutbox.id, id));
    expect(row!.lastError).toBe("421 <adresse> try later");
    expect(row!.nextAttemptAt.getTime()).toBe(t0.getTime() + 60_000);
    // vor Ablauf der Wartezeit nicht erneut
    expect(await deliverOutbox(h.db, { sender: failing, now: new Date(t0.getTime() + 30_000) })).toEqual({ sent: 0, retry: 0, failed: 0 });
    for (let i = 2; i <= MAIL_MAX_ATTEMPTS; i++) {
      now = row!.nextAttemptAt;
      await deliverOutbox(h.db, { sender: failing, now });
      [row] = await h.db.select().from(mailOutbox).where(eq(mailOutbox.id, id));
    }
    expect(row).toMatchObject({ attempts: MAIL_MAX_ATTEMPTS, to: "", text: "", sentAt: null });
    expect(row!.failedAt).not.toBeNull();
    expect(await outboxStats(h.db)).toMatchObject({ pending: 0, failed: 1 });
  });

  it("Wiederholung nach einem Fehler gelingt", async () => {
    await enqueueMail(h.db, mail(), t0);
    let fail = true;
    const sender = async () => {
      if (fail) throw new Error("weg");
    };
    await deliverOutbox(h.db, { sender, now: t0 });
    fail = false;
    expect(await deliverOutbox(h.db, { sender, now: new Date(t0.getTime() + 60_000) })).toEqual({ sent: 1, retry: 0, failed: 0 });
  });

  it("GATE-4c (L8): Testmail-Knopf und Job gleichzeitig – die Mail geht genau einmal raus", async () => {
    const id = await enqueueMail(h.db, mail(), t0);
    const sent: string[] = [];
    // während sendNow noch sendet, läuft der Minuten-Job über dieselbe Warteschlange
    let job: Awaited<ReturnType<typeof deliverOutbox>> | null = null;
    const slow = async () => {
      sent.push("knopf");
      job = await deliverOutbox(h.db, { sender: async () => void sent.push("job"), now: t0 });
    };
    expect(await sendNow(h.db, id, slow, t0)).toEqual({ ok: true });
    expect(job).toEqual({ sent: 0, retry: 0, failed: 0 });
    expect(sent).toEqual(["knopf"]);
  });

  it("sendNow (Testmail-Knopf): sofort, Fehler mit Meldung und Wiederholung über den Job", async () => {
    const ok = await enqueueMail(h.db, mail(), t0);
    expect(await sendNow(h.db, ok, async () => {}, t0)).toEqual({ ok: true });
    expect(await sendNow(h.db, ok, async () => {}, t0)).toMatchObject({ ok: false });
    const bad = await enqueueMail(h.db, mail(), t0);
    expect(
      await sendNow(
        h.db,
        bad,
        async () => {
          throw new Error("Verbindung abgelehnt");
        },
        t0,
      ),
    ).toEqual({ ok: false, error: "Verbindung abgelehnt" });
    expect((await outboxStats(h.db)).pending).toBe(1);
  });

  it("ohne SMTP sendet der Job nichts (Mails bleiben für /dev/mail lesbar)", async () => {
    await enqueueMail(h.db, mail(), t0);
    expect(await deliverWithConfig(h.db, t0, null)).toBeNull();
    expect((await listOutbox(h.db))[0]).toMatchObject({ text: "Hallo", sentAt: null });
  });
});
