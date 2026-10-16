import { describe, expect, it } from "vitest";
import { forwardedClientIp, ipInNets, networkZone, parseIp, parseNetList } from "./schulnetz";

const nets = (s: string) => parseNetList(s).nets;
const h = (init: Record<string, string>) => new Headers(init);

describe("SEC-01: Schulnetz-Bereiche", () => {
  it("liest CIDR, einzelne Adressen, IPv6 und private_ranges; Unsinn landet in errors", () => {
    const r = parseNetList("10.20.0.0/16, 192.168.5.7\n2001:db8::/32 ; private_ranges kaputt 10.0.0.0/33 1.2.3.4/x");
    expect(r.errors).toEqual(["kaputt", "10.0.0.0/33", "1.2.3.4/x"]);
    expect(r.nets.length).toBeGreaterThan(4);
    expect(parseIp("::ffff:10.1.2.3")).toEqual({
      v: 4,
      n: parseIp("10.1.2.3")!.n,
    });
    expect(parseIp("999.1.1.1")).toBeNull();
  });

  it("prüft Zugehörigkeit je Familie und Präfix", () => {
    const n = nets("10.20.0.0/16 192.168.5.7 2001:db8::/32");
    expect(ipInNets("10.20.255.1", n)).toBe(true);
    expect(ipInNets("10.21.0.1", n)).toBe(false);
    expect(ipInNets("192.168.5.7", n)).toBe(true);
    expect(ipInNets("192.168.5.8", n)).toBe(false);
    expect(ipInNets("2001:db8:1::5", n)).toBe(true);
    expect(ipInNets("2001:db9::5", n)).toBe(false);
    expect(ipInNets("::ffff:10.20.1.1", n)).toBe(true);
    expect(ipInNets("kein-ip", n)).toBe(false);
    const priv = nets("private_ranges");
    for (const ip of ["10.1.1.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "127.0.0.1", "fd12::1", "::1"])
      expect(ipInNets(ip, priv)).toBe(true);
    for (const ip of ["172.32.0.1", "8.8.8.8", "2001:db8::1"]) expect(ipInNets(ip, priv)).toBe(false);
  });
});

describe("SEC-01: Client-Adresse und Zone", () => {
  const school = nets("10.0.0.0/8");

  it("liest X-Forwarded-For von rechts – vorangestellte (gefälschte) Einträge zählen nicht", () => {
    // Browser schickt „10.0.0.5“ mit, Caddy hängt die echte Adresse an bzw. ersetzt den Header
    expect(forwardedClientIp(h({ "x-forwarded-for": "10.0.0.5, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(networkZone(h({ "x-forwarded-for": "10.0.0.5, 203.0.113.9" }), school)).toBe("aussen");
    expect(networkZone(h({ "x-forwarded-for": "10.0.0.5" }), school)).toBe("schulnetz");
  });

  it("überspringt nur eingetragene Proxys", () => {
    const trusted = nets("192.0.2.10");
    expect(forwardedClientIp(h({ "x-forwarded-for": "10.0.0.5, 192.0.2.10" }), trusted)).toBe("10.0.0.5");
    expect(forwardedClientIp(h({ "x-forwarded-for": "10.0.0.5, 192.0.2.11" }), trusted)).toBe("192.0.2.11");
    expect(networkZone(h({ "x-forwarded-for": "10.0.0.5, 192.0.2.11" }), school, trusted)).toBe("aussen");
  });

  it("Kennzeichen von Caddy (außen) schlägt jede Adresse; Unsinn im Header gilt als außen; ohne Header Schulnetz", () => {
    expect(networkZone(h({ "x-schulos-extern": "alles", "x-forwarded-for": "10.0.0.5" }), school)).toBe("aussen");
    expect(networkZone(h({ "x-forwarded-for": "10.0.0.5, unsinn" }), school)).toBe("aussen");
    expect(networkZone(h({}), school)).toBe("schulnetz");
  });
});
