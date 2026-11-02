import { describe, expect, it } from "vitest";
import { hostProblems, osSupportState, parseOrder, parseOsRelease, rebootPendingDays, REBOOT_RED_DAYS, tlsRenewalOverdue, type TlsInfo } from "./system";

const TRIXIE = 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION_CODENAME=trixie\nID=debian\n';

describe("Betriebssystem", () => {
  it("liest /etc/os-release und kennt die Supportzeiträume", () => {
    expect(parseOsRelease(TRIXIE)).toEqual({
      name: "Debian GNU/Linux 13 (trixie)",
      versionId: "13",
      codename: "trixie",
      securityUntil: "2028-08-09",
      ltsUntil: "2030-06-30",
    });
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 24.04"\nID=ubuntu\nVERSION_ID="24.04"\n')).toMatchObject({ securityUntil: null, ltsUntil: null });
  });

  it("Hinweis ab 6 Monaten vor dem Ende, dann LTS, dann abgelaufen", () => {
    const os = parseOsRelease(TRIXIE);
    expect(osSupportState(os, new Date("2027-12-01T00:00:00Z"))).toBe("ok");
    expect(osSupportState(os, new Date("2028-02-09T00:00:00Z"))).toBe("wechsel-empfohlen");
    expect(osSupportState(os, new Date("2028-08-10T00:00:00Z"))).toBe("nur-lts");
    expect(osSupportState(os, new Date("2030-07-01T00:00:00Z"))).toBe("abgelaufen");
    expect(osSupportState({ ...os, securityUntil: null }, new Date())).toBe("unbekannt");
  });
});

describe("Auftrag aus der Verwaltung", () => {
  const base = { version: 1, id: "auftrag-1", createdAt: "2026-10-05T10:00:00Z", by: "u-admin" };
  it("Freigabe und Kanalwechsel", () => {
    expect(parseOrder({ ...base, action: "freigabe", target: "1.5.0", when: "wartungsfenster" })).toMatchObject({ action: "freigabe" });
    expect(parseOrder({ ...base, action: "kanal", channel: "beta" })).toMatchObject({ channel: "beta" });
    expect(parseOrder({ ...base, action: "neustart" })).toMatchObject({ action: "neustart" });
  });

  it("lehnt Unsinn ab", () => {
    expect(() => parseOrder(null)).toThrow("kein Objekt");
    expect(() => parseOrder({ ...base, id: "x" })).toThrow("ungültig");
    expect(() => parseOrder({ ...base, action: "freigabe", target: "1.5; rm -rf /", when: "jetzt" })).toThrow("Zielversion");
    expect(() => parseOrder({ ...base, action: "freigabe", target: "1.5.0", when: "morgen" })).toThrow("Zeitpunkt");
    expect(() => parseOrder({ ...base, action: "kanal", channel: "nightly" })).toThrow("Kanal");
    expect(() => parseOrder({ ...base, action: "shell" })).toThrow("unbekannte Aktion");
  });
});

describe("Neustart mit Passphrase (Q5-18)", () => {
  it("zählt ganze Tage seit dem Erkennen; rot ab 14 Tagen", () => {
    const since = "2026-10-01T03:00:00Z";
    expect(rebootPendingDays({ since }, new Date("2026-10-01T23:00:00Z"))).toBe(0);
    expect(rebootPendingDays({ since }, new Date("2026-10-15T02:59:00Z"))).toBe(13);
    expect(rebootPendingDays({ since }, new Date("2026-10-15T03:00:00Z"))).toBe(REBOOT_RED_DAYS);
    expect(rebootPendingDays({ since }, new Date("2026-09-30T00:00:00Z"))).toBe(0);
  });
});

describe("CA-08: Erneuerung öffentlicher Zertifikate", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const day = 86_400_000;
  const tls = (restDays: number, lifeDays = 90, extra: Partial<TlsInfo> = {}): TlsInfo => {
    const exp = now.getTime() + restDays * day;
    return { expiresAt: new Date(exp).toISOString(), issuedAt: new Date(exp - lifeDays * day).toISOString(), acme: true, ...extra };
  };

  it("überfällig erst nach dem Erneuerungszeitpunkt (Drittel der Laufzeit) plus Spielraum", () => {
    expect(tlsRenewalOverdue(tls(28), now)).toBe(false);
    expect(tlsRenewalOverdue(tls(26), now)).toBe(true);
    // kurze Laufzeit (6 Tage): Erneuerung bei 2 Tagen Rest, Spielraum 0,6 Tage
    expect(tlsRenewalOverdue(tls(1.5, 6), now)).toBe(false);
    expect(tlsRenewalOverdue(tls(1.2, 6), now)).toBe(true);
    // eigene CA, unbekanntes Ausstellungsdatum, Unsinn → nie
    expect(tlsRenewalOverdue(tls(1, 90, { acme: false }), now)).toBe(false);
    expect(tlsRenewalOverdue({ expiresAt: tls(1).expiresAt, acme: true }, now)).toBe(false);
    expect(tlsRenewalOverdue({ expiresAt: "x", issuedAt: "y", acme: true }, now)).toBe(false);
  });

  it("Befunde: überfällig (Warnung), unter 14 Tagen der bisherige Befund mit Hinweis, nicht vertrauenswürdig", () => {
    const keys = (t: TlsInfo) => hostProblems({ tls: t, diskWarnPercent: 101, now }).map((p) => `${p.key}:${p.level}`);
    expect(keys(tls(40))).toEqual([]);
    expect(keys(tls(20))).toEqual(["zertifikat:erneuerung:warn"]);
    expect(keys(tls(10))).toEqual(["zertifikat:warn"]);
    expect(hostProblems({ tls: tls(10), diskWarnPercent: 101, now })[0]!.text).toBe("Zertifikat läuft in 10 Tagen ab – die automatische Erneuerung klappt nicht");
    expect(hostProblems({ tls: tls(10, 90, { acme: false }), diskWarnPercent: 101, now })[0]!.text).toBe("Zertifikat läuft in 10 Tagen ab");
    expect(keys(tls(60, 90, { trusted: false }))).toEqual(["zertifikat:vertrauen:warn"]);
    // eigene CA ist nie „öffentlich vertrauenswürdig“ – kein Befund
    expect(keys(tls(60, 90, { trusted: false, acme: false }))).toEqual([]);
  });
});
