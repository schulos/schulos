// SEC-12 / G4E-O06 / G4E-O17: Netze für SSH prüfen und normieren, Regel/sshd/Bindung von ssh.service – gemeinsam für Installer
// und `schulosctl ssh-netze`. Das echte Aussperren (nft, sshd) prüft die CI (scripts/qemu-test.sh Schritt 2c).
import { describe, expect, it } from "vitest";
import {
  addressInNets,
  checkNet,
  netsFromRules,
  netsFromSshdConfig,
  sshdConfig,
  sshNetList,
  sshNetRules,
  sshRequiresDropin,
  withSshdNets,
} from "./ssh-netz";

describe("G4E-O06: Netze prüfen", () => {
  it("Netzadresse ok, Host-Bits → Fehler mit Vorschlag, Unsinn → Fehler", () => {
    expect(checkNet("10.10.0.0/16")).toEqual({ ok: true, net: "10.10.0.0/16" });
    expect(checkNet(" 192.168.1.7 ")).toEqual({ ok: true, net: "192.168.1.7" });
    expect(checkNet("10.10.0.5/24")).toEqual({
      ok: false,
      error: "„10.10.0.5/24“ hat gesetzte Host-Bits – gemeint ist wohl 10.10.0.0/24",
      suggestion: "10.10.0.0/24",
    });
    expect(checkNet("fd00::/8")).toEqual({ ok: true, net: "fd00::/8" });
    expect(checkNet("fd12:3456::1/64")).toMatchObject({ ok: false, suggestion: "fd12:3456::/64" });
    expect(checkNet("FD00:0:0:0:0:0:0:0/8")).toEqual({ ok: true, net: "fd00::/8" });
    expect(checkNet("0.0.0.0/0")).toEqual({ ok: true, net: "0.0.0.0/0" });
    for (const bad of ["10.0.0.0/33", "300.1.1.1/8", "10.0.0/8", "x", "10.0.0.0/8/1", "fd00::/129", "1::2::3"]) expect(checkNet(bad).ok).toBe(false);
  });

  it("eigene Adresse in den Netzen? (SSH-Sitzung nicht abschneiden)", () => {
    expect(addressInNets("10.10.3.4", ["10.10.0.0/16"])).toBe(true);
    expect(addressInNets("10.11.3.4", ["10.10.0.0/16"])).toBe(false);
    expect(addressInNets("::ffff:10.10.3.4", ["10.10.0.0/16"])).toBe(true);
    expect(addressInNets("fd00::5", ["fd00::/8"])).toBe(true);
    expect(addressInNets("192.168.1.7", ["192.168.1.7"])).toBe(true);
    expect(addressInNets("unsinn", ["0.0.0.0/0"])).toBe(false);
  });

  it("Vorgabe private Bereiche, „von überall“ = keine Einschränkung", () => {
    expect(sshNetList([])).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"]);
    expect(sshNetList([" 10.8.0.0/24 ", ""])).toEqual(["10.8.0.0/24"]);
    expect(sshNetList(["10.0.0.0/8", "::/0"])).toBeNull();
  });
});

describe("G4E-O06/O17: Regel, sshd, Bindung von ssh.service", () => {
  it("sshd: AllowUsers je Netz; ändern lässt die übrigen Zeilen stehen; Netze wieder auslesen", () => {
    const conf = sshdConfig(["10.0.0.0/8"], true);
    expect(conf).toContain("AllowUsers schulos-admin@10.0.0.0/8");
    expect(conf).toContain("PasswordAuthentication no");
    const changed = withSshdNets(conf, ["10.8.0.0/24", "fd00::/8"]);
    expect(changed).toContain("AllowUsers schulos-admin@10.8.0.0/24 schulos-admin@fd00::/8");
    expect(changed).toContain("PasswordAuthentication no");
    expect(changed).not.toContain("10.0.0.0/8");
    expect(netsFromSshdConfig(changed)).toEqual(["10.8.0.0/24", "fd00::/8"]);
    expect(netsFromSshdConfig(sshdConfig(null, false))).toBeNull();
    expect(withSshdNets("# SchulOS\nPermitRootLogin no\n", ["10.0.0.0/8"]).split("\n")[1]).toBe("AllowUsers schulos-admin@10.0.0.0/8");
  });

  it("Regel-Datei: Netze wieder auslesen; ssh.service braucht die Regel (fail closed)", () => {
    expect(netsFromRules(sshNetRules(["10.8.0.0/24", "192.168.0.0/16", "fd00::/8"]))).toEqual(["10.8.0.0/24", "192.168.0.0/16", "fd00::/8"]);
    expect(sshRequiresDropin()).toContain("Requires=schulos-ssh-netz.service");
    expect(sshRequiresDropin()).toContain("After=schulos-ssh-netz.service");
  });
});
