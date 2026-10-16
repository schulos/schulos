import { describe, expect, it } from "vitest";
import { parseEnvFile } from "@schulos/server/config";
import { checkHttpsUrl, checkProxyUrl, envSafe, inSubnet, isDiskPath, isDomain, isIpOrCidr, isPublicDomain, isSshKey, parseCidr, parseIPv4, parseWindow } from "./checks";
import { envFile, envLine } from "./generate";
import { rcloneObscure, rcloneReveal } from "./rclone";

describe("Prüfungen", () => {
  it("Domains und Hostnamen; Let's Encrypt nur für öffentliche Domains", () => {
    expect(isDomain("schulos.schule-xy.de")).toBe(true);
    expect(isDomain("schulos")).toBe(true);
    expect(isDomain("-schulos.de")).toBe(false);
    expect(isDomain("192.168.1.5")).toBe(false);
    expect(isDomain("a..b")).toBe(false);
    expect(isPublicDomain("schulos.schule-xy.de")).toBe(true);
    for (const d of ["schulos", "schulos.local", "schulos.lan", "srv.schule.internal", "x.home.arpa"]) expect(isPublicDomain(d)).toBe(false);
  });

  it("IPv4, Präfix und Netz", () => {
    expect(parseIPv4("192.168.10.5")).toBe(3232238085);
    for (const bad of ["192.168.10", "192.168.010.5", "256.1.1.1", "a.b.c.d"]) expect(parseIPv4(bad)).toBeNull();
    const net = parseCidr("192.168.10.5/24");
    expect(net.ok).toBe(true);
    if (!net.ok) return;
    expect(inSubnet(parseIPv4("192.168.10.1")!, net.cidr)).toBe(true);
    expect(inSubnet(parseIPv4("192.168.11.1")!, net.cidr)).toBe(false);
    expect(parseCidr("192.168.10.0/24")).toMatchObject({ ok: false, error: expect.stringContaining("Netz") });
    expect(parseCidr("192.168.10.255/24")).toMatchObject({ ok: false });
    expect(parseCidr("192.168.10.5/31")).toMatchObject({ ok: false, error: expect.stringContaining("Präfix") });
    expect(parseCidr("192.168.10.5")).toMatchObject({ ok: false });
  });

  it("Proxy-Adressen (P4-40): IPv4/IPv6 mit oder ohne Präfix, Netzadresse erlaubt", () => {
    for (const ok of ["10.0.0.5", "10.0.0.0/29", "0.0.0.0/0", "fd00::5", "fd00::/64", "2001:db8:1:2::/56", "::1"]) expect(isIpOrCidr(ok), ok).toBe(true);
    for (const bad of ["10.0.0", "10.0.0.5/33", "10.0.0.5/", "proxy.schule.de", "fd00::/129", "1::2::3", "fd00:12345::1", "10.0.0.5/24/1", "private_ranges", ""])
      expect(isIpOrCidr(bad), bad).toBe(false);
  });

  it("Wartungsfenster: 1–6 Stunden, auch über Mitternacht", () => {
    expect(parseWindow("02:00-04:00")).toEqual({ ok: true, start: 120, end: 240, minutes: 120 });
    expect(parseWindow("23:00 – 01:00")).toMatchObject({ ok: true, minutes: 120 });
    expect(parseWindow("02:00-02:30")).toMatchObject({ ok: false });
    expect(parseWindow("01:00-09:00")).toMatchObject({ ok: false });
    expect(parseWindow("2-4")).toMatchObject({ ok: false });
  });

  it("Adressen, SSH-Schlüssel, Gerätepfade", () => {
    expect(checkHttpsUrl("https://backup.schule.de")).toBeNull();
    expect(checkHttpsUrl("https://backup.schule.de:9443/")).toBeNull();
    expect(checkHttpsUrl("http://backup.schule.de")).toMatch(/https/);
    expect(checkHttpsUrl("https://backup.schule.de/x")).toMatch(/Pfad/);
    expect(checkProxyUrl("http://proxy.schule.de:3128")).toBeNull();
    expect(checkProxyUrl("http://proxy.schule.de")).toMatch(/Port/);
    expect(isSshKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJsIDXR/63YbcH3XVTQfw1nDgH+dRYjXxKh6YShsVxjT admin@pc")).toBe(true);
    expect(isSshKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(false);
    expect(isDiskPath("/dev/nvme0n1")).toBe(true);
    expect(isDiskPath("/dev/disk/by-id/ata-Samsung_SSD_870-XYZ")).toBe(true);
    expect(isDiskPath("/dev/../etc/passwd")).toBe(false);
    expect(isDiskPath("sda")).toBe(false);
  });
});

describe("env-Dateien", () => {
  it("Werte kommen über parseEnvFile unverändert zurück; Compose-Ersetzung ($) greift nicht", () => {
    const values = {
      PLAIN: "abc-123_x.y:z/@+=%",
      SPACE: "Gesamtschule am See",
      DOLLAR: "pa$$w0rd #1 ${HOME}",
      APOSTROPH: "St. Mary's School",
      FROM: "SchulOS <schulos@schule.de>",
    };
    const text = envFile(["Kommentar", ...Object.entries(values), ["LEER", ""], ["FEHLT", undefined]]);
    expect(text).toContain("DOLLAR='pa$$w0rd #1 ${HOME}'");
    expect(text).toContain(`APOSTROPH="St. Mary's School"`);
    expect(text).not.toContain("LEER");
    expect(parseEnvFile(text)).toEqual(values);
  });

  it("nicht sicher schreibbare Werte werden abgelehnt", () => {
    expect(envSafe(`it's $x`)).toBe(false);
    expect(envSafe("a\nb")).toBe(false);
    expect(envSafe("it's ok")).toBe(true);
    expect(() => envLine("X", `it's "quoted"`)).toThrow(/X/);
  });
});

describe("rclone obscure", () => {
  it("liest, was rclone selbst verschleiert hat, und umgekehrt", () => {
    // Ausgabe von: docker run --rm rclone/rclone obscure 'geheim-Passwort 1'
    expect(rcloneReveal("gfcwrqS5vBMUR7VTHQtxJQP1A6uygpBuZcKoD5Ht1aKb")).toBe("geheim-Passwort 1");
    const o = rcloneObscure("ä$'\"x");
    expect(o).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rcloneReveal(o)).toBe("ä$'\"x");
    expect(rcloneObscure("x")).not.toBe(rcloneObscure("x"));
  });
});
