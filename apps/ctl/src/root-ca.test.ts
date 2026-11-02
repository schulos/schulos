import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyAgentState } from "@schulos/server/agent-api";
import { formatStatus, statusReport, type StatusInput } from "./core";
import { CADDY_ROOT_CRT, firstCertificatePem, readCaddyRoot, rootCaInfo, tlsIsInternal } from "./root-ca";
import { buildStatus } from "./system-sync";

const fixtures = path.join(import.meta.dirname, "../../../packages/server/test-fixtures");
const caPem = readFileSync(path.join(fixtures, "ca.pem"), "utf8");
const leafPem = readFileSync(path.join(fixtures, "localhost.pem"), "utf8");
const keyPem = readFileSync(path.join(fixtures, "localhost.key"), "utf8");

describe("Root der eigenen CA (CA-02)", () => {
  it("eigene CA nur bei TLS-Modus internal (Vorgabe), nicht bei Let's Encrypt", () => {
    expect(tlsIsInternal(undefined)).toBe(true);
    expect(tlsIsInternal("internal")).toBe(true);
    expect(tlsIsInternal(" internal ")).toBe(true);
    expect(tlsIsInternal("it@schule.de")).toBe(false);
  });

  it("nur das Zertifikat – ein Schlüssel davor/danach wird nie übernommen; Windows-Zeilenenden normalisiert", () => {
    const pem = firstCertificatePem(`${keyPem}\n${caPem.replace(/\n/g, "\r\n")}`);
    expect(pem).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(pem).not.toContain("PRIVATE KEY");
    expect(pem).not.toContain("\r");
    expect(firstCertificatePem(keyPem)).toBeNull();
  });

  it("SHA-256-Fingerabdruck und Ablauf; ein Serverzertifikat ist keine Root", () => {
    const info = rootCaInfo(caPem);
    expect(info?.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(info?.notAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rootCaInfo(leafPem)).toBeNull();
    expect(rootCaInfo("kaputt")).toBeNull();
  });

  it("liest root.crt aus dem Caddy-Container – nur bei internal, Fehler → null", async () => {
    const calls: string[][] = [];
    const ok = async (a: string[]) => (calls.push(a), { code: 0, stdout: caPem });
    expect((await readCaddyRoot("internal", ok))?.info.fingerprint).toBe(rootCaInfo(caPem)!.fingerprint);
    expect(calls).toEqual([["exec", "-T", "caddy", "cat", CADDY_ROOT_CRT]]);
    expect(CADDY_ROOT_CRT).toMatch(/root\.crt$/);
    expect(await readCaddyRoot("it@schule.de", ok)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(await readCaddyRoot("internal", async () => ({ code: 1, stdout: "" }))).toBeNull();
    expect(await readCaddyRoot("internal", async () => Promise.reject(new Error("docker fehlt")))).toBeNull();
    expect(await readCaddyRoot(undefined, async () => ({ code: 0, stdout: leafPem }))).toBeNull();
  });

  it("schulosctl status zeigt den Fingerabdruck in zwei Zeilen (≤ 100 Zeichen), --json und Systemstatus tragen ihn", () => {
    const rootCa = rootCaInfo(caPem)!;
    const input: StatusInput = { services: [{ service: "app", state: "running", health: "healthy" }], app: null, backup: emptyAgentState("i"), disk: null, now: new Date(), rootCa };
    const { lines } = formatStatus(input);
    const at = lines.findIndex((l) => l.startsWith("Schul-Zertifikat"));
    expect(at).toBeGreaterThan(0);
    expect(`${lines[at + 1]!.trim()}:${lines[at + 2]!.trim()}`).toBe(rootCa.fingerprint);
    expect(lines.every((l) => l.length <= 100)).toBe(true);
    expect(statusReport(input).rootCa).toEqual(rootCa);
    expect(statusReport({ ...input, rootCa: null }).rootCa).toBeNull();
    expect(formatStatus({ ...input, rootCa: null }).lines.some((l) => l.startsWith("Schul-Zertifikat"))).toBe(false);
    const base = { now: new Date(), current: "1.0.0", channel: "stabil" as const, plan: null, approved: null, protocol: [], os: null };
    expect(buildStatus({ ...base, rootCa }).rootCa).toEqual(rootCa);
    expect(buildStatus(base).rootCa).toBeNull();
  });
});
