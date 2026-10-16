// SEC-12: Admin-Ebene (SSH) nur aus dem Schulnetz bzw. über WireGuard – Frage, sshd, nftables-Regel. Dass Port 22 von „außen“
// wirklich zu ist, prüft nur die CI (scripts/qemu-test.sh: Verbindung mit fremder Absenderadresse).
import { describe, expect, it } from "vitest";
import { resolve } from "../answers";
import { CTX, PRODUCTION } from "../fixtures";
import { QUESTION_BY_ID } from "../questions";
import { sshNetSteps, systemConfigSteps } from "./steps";
import { packageLists } from "./steps";
import {
  SSH_NET_FILE,
  SSH_REQUIRES_DROPIN,
  sshdConf,
  sshNetRules,
  sshNets,
  sshNetUnit,
} from "./target-config";

describe("SEC-12: SSH nur aus dem Schulnetz/WireGuard", () => {
  it("Frage „Schulnetz-Bereiche“ (auch ohne SSH), Vorgabe private Netze, Prüfung und Warnung bei „von überall“", () => {
    const q = QUESTION_BY_ID.get("network.internal_nets")!;
    expect(
      resolve({ ...PRODUCTION, "access.ssh": true }, CTX).answers[
        "network.internal_nets"
      ],
    ).toEqual(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"]);
    // SEC-01: gilt auch ohne SSH (Schulnetz für App und Caddy)
    expect(
      resolve({ ...PRODUCTION, "access.ssh": false }, CTX).answers[
        "network.internal_nets"
      ],
    ).toHaveLength(4);
    expect(q.validate!(["10.8.0.0/24"], PRODUCTION, CTX)).toBeNull();
    expect(q.validate!(["schulnetz"], PRODUCTION, CTX)).toMatch(/kein Netz/);
    // G4E-O06: Host-Bits → Fehler mit Vorschlag (sshd lehnte das Netz ab, niemand käme mehr per SSH herein) – auch per Antwortdatei
    expect(q.validate!(["10.10.0.5/24"], PRODUCTION, CTX)).toBe("„10.10.0.5/24“ hat gesetzte Host-Bits – gemeint ist wohl 10.10.0.0/24");
    const r = resolve({ ...PRODUCTION, "access.ssh": true, "network.internal_nets": ["10.10.0.5/24"] }, CTX);
    expect(r.complete).toBe(false);
    expect(r.errors.map((e) => e.id)).toContain("network.internal_nets");
    expect(q.validate!([], PRODUCTION, CTX)).toMatch(/Mindestens ein Netz/);
    expect(q.warn!(["0.0.0.0/0"], PRODUCTION, CTX)).toMatch(/Internet/);
    expect(q.warn!(["10.8.0.0/24"], PRODUCTION, CTX)).toBeNull();
  });

  it("sshd nimmt das Wartungskonto nur aus den Netzen an; „von überall“ ohne Einschränkung", () => {
    const a = {
      "access.ssh": true,
      "network.internal_nets": ["10.8.0.0/24", "192.168.10.0/24"],
    };
    expect(sshdConf(a)).toContain(
      "AllowUsers schulos-admin@10.8.0.0/24 schulos-admin@192.168.10.0/24\n",
    );
    expect(
      sshNets({ "access.ssh": true, "network.internal_nets": ["0.0.0.0/0"] }),
    ).toBeNull();
    expect(sshdConf({ "network.internal_nets": ["0.0.0.0/0"] })).toContain(
      "AllowUsers schulos-admin\n",
    );
  });

  it("nftables: eigene Tabelle (kein flush ruleset – Dockers Regeln bleiben), Loopback offen, Port 22 sonst zu", () => {
    const r = sshNetRules(["10.8.0.0/24", "fd00::/8"]);
    expect(r).not.toContain("flush ruleset");
    expect(r).toContain("table inet schulos_ssh {");
    expect(r).toContain("iif lo accept");
    expect(r).toContain("tcp dport 22 ip saddr { 10.8.0.0/24 } accept");
    expect(r).toContain("tcp dport 22 ip6 saddr { fd00::/8 } accept");
    expect(r.indexOf("accept")).toBeLessThan(r.indexOf("tcp dport 22 drop"));
    expect(sshNetRules(["10.0.0.0/8"])).not.toContain("ip6 saddr");
    expect(sshNetUnit()).toContain(
      `ExecStart=/usr/sbin/nft -f ${SSH_NET_FILE}`,
    );
    expect(sshNetUnit()).toContain("Before=network-pre.target ssh.service");
    expect(packageLists().apt).toContain("nftables");
  });

  it("Schritte: mit SSH Regel + Dienst; ohne SSH oder „von überall“ keine; Abbild-Einrichtung schaltet sofort ein", () => {
    const on = systemConfigSteps(
      {
        ...PRODUCTION,
        "access.ssh": true,
        "network.internal_nets": ["10.8.0.0/24"],
      },
      "/target",
    );
    expect(
      on.some((s) => s.kind === "write" && s.path === `/target${SSH_NET_FILE}`),
    ).toBe(true);
    // G4E-O06: fail closed – sshd nur mit geladener Regel
    expect(
      on.find((s) => s.kind === "write" && s.path === `/target${SSH_REQUIRES_DROPIN}`),
    ).toMatchObject({ content: expect.stringContaining("Requires=schulos-ssh-netz.service") });
    expect(
      on.some(
        (s) =>
          s.kind === "run" &&
          s.argv.join(" ") ===
            "chroot /target systemctl enable schulos-ssh-netz.service",
      ),
    ).toBe(true);
    expect(sshNetSteps({ "access.ssh": false }, "/target")).toEqual([]);
    expect(
      sshNetSteps(
        { "access.ssh": true, "network.internal_nets": ["0.0.0.0/0"] },
        "/target",
      ),
    ).toEqual([]);
    const now = sshNetSteps({ "access.ssh": true }, "");
    expect(
      now.some(
        (s) =>
          s.kind === "run" &&
          s.argv.join(" ") ===
            "systemctl enable --now schulos-ssh-netz.service",
      ),
    ).toBe(true);
  });

  it("SEC-01: Schulnetz in die .env (Caddy und App) nur, wenn von der Vorgabe abweichend", async () => {
    const { generate } = await import("../generate");
    const env = async (nets?: string[]) => {
      const plan = await generate(
        { ...PRODUCTION, ...(nets ? { "network.internal_nets": nets } : {}) },
        { hashPassword: async () => "h" },
        CTX,
      );
      return plan.files.find((f) => f.path.endsWith("/.env"))!.content;
    };
    expect(await env()).not.toContain("SCHULOS_INTERNAL_NETS");
    expect(await env(["10.10.0.0/16", "10.8.0.0/24"])).toContain(
      "10.10.0.0/16 10.8.0.0/24",
    );
    expect(await env(["10.10.0.0/16"])).toMatch(/^SCHULOS_INTERNAL_NETS=/m);
    const compose = (await import("node:fs")).readFileSync(
      `${__dirname}/../../../../compose.yaml`,
      "utf8",
    );
    expect(compose).toContain(
      "SCHULOS_INTERNAL_NETS: ${SCHULOS_INTERNAL_NETS:-}",
    );
  });
});
