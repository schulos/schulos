import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkBackupServer, pairWithBackup, PairingError } from "@schulos/server/pairing-client";
import { aad, open, pairingKey, pairingLookup, seal, sha256Hex } from "@schulos/server/pairing";
import { RequestError, type requestJson } from "@schulos/server/pinned-request";
import { createUserWithPassword } from "@/auth/auth";
import type { DbHandle } from "@/db/client";
import { auditLog, instances, pairingCodes } from "@/db/schema";
import { createTestDb } from "@/db/testing";
import { agentPlan, authenticateAgent } from "@/agent/service";
import { withUser } from "./htpasswd";
import {
  createPairingCode,
  forgetPairingResults,
  listInstances,
  openCodes,
  pairingClaim,
  pairingHello,
  PairingRejected,
  PAIRING_REPLAY_MINUTES,
  registerInitialCode,
  repoPassword,
  revokeCode,
  unpairInstance,
  type PairingContext,
} from "./service";

const fx = (f: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "..", "..", "packages", "server", "test-fixtures", f), "utf8");
const SECRET = "test-app-secret-0123456789";

describe("htpasswd", () => {
  it("ersetzt, ergänzt und entfernt Benutzer zeilenweise", () => {
    let t = withUser("", "i-1", "$2b$h1");
    t = withUser(t, "i-2", "$2b$h2");
    t = withUser(t, "i-1", "$2b$neu");
    expect(t).toBe("i-2:$2b$h2\ni-1:$2b$neu\n");
    expect(withUser(withUser(t, "i-1", null), "i-2", null)).toBe("");
  });
});

describe("Kopplung Hauptsystem ↔ Backupserver (echtes TLS mit gepinnter CA)", () => {
  let h: DbHandle;
  let server: https.Server;
  let url: string;
  let restDir: string;
  const ctx: PairingContext = { appSecret: SECRET, caPem: null, serverName: "Backup Lindenhof", restDir: "", restBaseUrl: "https://backup.test/restic" };

  beforeAll(async () => {
    h = await createTestDb();
    await createUserWithPassword(h.db, { id: "adm", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: "x:y" });
    restDir = mkdtempSync(path.join(tmpdir(), "schulos-rest-"));
    ctx.restDir = restDir;
    // Mini-Backupserver: dieselben Service-Funktionen wie die API-Routen, über HTTPS mit dem Test-Zertifikat
    server = https.createServer({ key: fx("localhost.key"), cert: fx("localhost.pem") }, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const send = (status: number, json: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(json));
        };
        try {
          if (req.url === "/api/pairing/hello") {
            const sealed = await pairingHello(h.db, String(req.headers["x-pairing-lookup"] ?? ""), ctx);
            return sealed ? send(200, { sealed }) : send(404, { error: "x" });
          }
          const b = JSON.parse(body) as { lookup: string; request: string };
          const sealed = await pairingClaim(h.db, b.lookup, b.request, ctx);
          return sealed ? send(200, { sealed }) : send(404, { error: "x" });
        } catch (err) {
          return send(err instanceof PairingRejected ? 400 : 500, { error: String(err) });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
    rmSync(restDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    ctx.caPem = fx("ca.pem");
  });

  const pair = (code: string) => pairWithBackup({ backupUrl: url, code, instanceName: "Gesamtschule am Lindenhof", mainUrl: "https://schulos.test" });

  it("koppelt: Instanz mit rest-server-Zugang, Repo-Passwort verschlüsselt, Code verbraucht; nach dem Wiederholungsfenster nur einmal", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    expect(await openCodes(h.db)).toHaveLength(1);
    const p = await pair(code.toLowerCase());

    expect(p).toMatchObject({ backupUrl: url, serverName: "Backup Lindenhof", caPem: fx("ca.pem"), instanceName: "Gesamtschule am Lindenhof" });
    expect(p.repoUrl).toBe(`https://backup.test/restic/${p.restUser}/`);
    expect(p.recoveryKey).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
    const [inst] = await listInstances(h.db);
    expect(inst).toMatchObject({ id: p.instanceId, restUser: p.restUser, mainUrl: "https://schulos.test", pairedBy: "adm" });
    expect(inst!.repoPasswordEnc).not.toContain(p.repoPassword);
    expect(repoPassword(inst!, SECRET)).toBe(p.repoPassword);
    expect(inst!.agentTokenHash).not.toBe(p.agentToken);
    const htpasswd = readFileSync(path.join(restDir, ".htpasswd"), "utf8");
    expect(htpasswd).toMatch(new RegExp(`^${p.restUser}:\\$2[aby]\\$10\\$`, "m"));
    expect(htpasswd).not.toContain(p.restPassword);
    expect(await openCodes(h.db)).toHaveLength(0);
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "kopplung.gekoppelt"))).map((a) => a.target)).toEqual([p.instanceId]);

    const later = new Date(Date.now() + (PAIRING_REPLAY_MINUTES + 1) * 60_000);
    const lookup = pairingLookup(code);
    const again = seal(pairingKey(code), { nonce: "n", instanceName: "x", mainUrl: "", repoPassword: "x".repeat(30) }, aad.claim(lookup));
    expect(await pairingClaim(h.db, lookup, again, ctx, later)).toBeNull();
    expect(await pairingHello(h.db, lookup, ctx, later)).toBeNull();
  });

  it("Antwort verloren: Wiederholung mit demselben Code liefert dasselbe Ergebnis – keine zweite Instanz", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const lookup = pairingLookup(code);
    const firstRepoPw = "erstes-repo-passwort-0123456789";
    // erster claim kommt an, die Antwort aber nicht beim Hauptsystem
    const lost = await pairingClaim(h.db, lookup, seal(pairingKey(code), { nonce: "weg", instanceName: "Lindenhof", mainUrl: "", repoPassword: firstRepoPw }, aad.claim(lookup)), ctx);
    const first = open<{ instanceId: string; restUser: string; restPassword: string; agentToken: string }>(pairingKey(code), lost!, aad.claimOk(lookup));
    const count = (await listInstances(h.db)).length;
    // erster Versuch brach nach der DB vor dem rest-server-Zugang ab
    writeFileSync(path.join(restDir, ".htpasswd"), withUser(readFileSync(path.join(restDir, ".htpasswd"), "utf8"), first.restUser, null));

    const p = await pair(code);
    expect(p).toMatchObject({ instanceId: first.instanceId, restUser: first.restUser, restPassword: first.restPassword, agentToken: first.agentToken });
    expect(p.repoPassword).toBe(firstRepoPw); // nicht das neue aus der Wiederholung – der Backupserver hat das erste
    expect(p.recoveryKey).toBeTruthy(); // Repository ist trotzdem neu
    expect(p.recoveryConfirmedAt).toBeNull();
    expect(await listInstances(h.db)).toHaveLength(count);
    expect(readFileSync(path.join(restDir, ".htpasswd"), "utf8")).toMatch(new RegExp(`^${first.restUser}:`, "m"));
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "kopplung.wiederholt"))).map((a) => a.target)).toContain(first.instanceId);

    // Wiederholung nur mit dem Code: andere Verschlüsselung wird abgelehnt
    const wrong = seal(pairingKey("AAAA-BBBB-CCCC"), { nonce: "n", instanceName: "x", mainUrl: "", repoPassword: "x".repeat(30) }, aad.claim(lookup));
    await expect(pairingClaim(h.db, lookup, wrong, ctx)).rejects.toThrow(PairingRejected);

    // nach dem Fenster räumt der Job das abgelegte Ergebnis weg
    await forgetPairingResults(h.db, new Date(Date.now() + (PAIRING_REPLAY_MINUTES + 1) * 60_000));
    const [row] = await h.db.select().from(pairingCodes).where(eq(pairingCodes.lookup, lookup));
    expect(row!.resultEnc).toBeNull();
    await expect(pair(code)).rejects.toThrow(/unbekannt, abgelaufen oder schon verwendet/);
  });

  it("SEC-06: meldet sich der Agent mit dem Token, ist das Wiederholungsfenster sofort zu", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const p = await pair(code);
    const inst = await authenticateAgent(h.db, `Bearer ${p.agentToken}`);
    await agentPlan(h.db, inst!);
    const [row] = await h.db.select().from(pairingCodes).where(eq(pairingCodes.instanceId, p.instanceId));
    expect(row!.resultEnc).toBeNull();
    await expect(pair(code)).rejects.toThrow(/unbekannt, abgelaufen oder schon verwendet/);
  });

  it("keine Wiederholung für eine inzwischen entkoppelte Instanz", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const p = await pair(code);
    await unpairInstance(h.db, "adm", p.instanceId, restDir);
    await expect(pair(code)).rejects.toThrow(/unbekannt, abgelaufen oder schon verwendet/);
    expect(readFileSync(path.join(restDir, ".htpasswd"), "utf8")).not.toContain(`${p.restUser}:`);
  });

  it("Vorab-Prüfung (Installer): erreichbar + Code gültig, ohne den Code zu verbrauchen", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    expect(await checkBackupServer({ backupUrl: url, code })).toEqual({ serverName: "Backup Lindenhof", ownCa: true });
    expect(await checkBackupServer({ backupUrl: `${url}/`, code: code.toLowerCase() })).toMatchObject({ serverName: "Backup Lindenhof" });
    expect(await openCodes(h.db)).toHaveLength(1);
    await expect(checkBackupServer({ backupUrl: url, code: "AAAA-BBBB-CCCC" })).rejects.toThrow(/unbekannt/);
    await expect(checkBackupServer({ backupUrl: "https://127.0.0.1:1", code })).rejects.toThrow(/nicht erreichbar/);
    // nicht erreichbar = vorübergehend (Installer wiederholt), falscher Code nicht
    await expect(checkBackupServer({ backupUrl: "https://127.0.0.1:1", code })).rejects.toMatchObject({ transient: true });
    await expect(checkBackupServer({ backupUrl: url, code: "AAAA-BBBB-CCCC" })).rejects.toMatchObject({ transient: false });
    await expect(checkBackupServer({ backupUrl: url, code: "x" })).rejects.toThrow(/Format/);
    // übergroße Antwort (B-55c): Abbruch, kein „später noch mal versuchen“
    const tooLarge = (() => Promise.reject(new RequestError("Antwort zu groß", "too_large"))) as typeof requestJson;
    await expect(checkBackupServer({ backupUrl: url, code }, { request: tooLarge })).rejects.toMatchObject({ transient: false, message: expect.stringMatching(/zu groß/) });
    expect((await pair(code)).serverName).toBe("Backup Lindenhof");
  });

  it("bricht ab, wenn das TLS-Zertifikat nicht zur genannten CA passt – der Code bleibt dann unverbraucht", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    ctx.caPem = fx("other-ca.pem"); // Backupserver nennt eine andere CA als die, die sein Zertifikat ausgestellt hat
    await expect(pair(code)).rejects.toThrow(/passt nicht zu der CA/);
    await expect(pair(code)).rejects.toMatchObject({ transient: false });
    expect(await openCodes(h.db)).toHaveLength(1);
  });

  it("ohne genannte CA gilt der System-Truststore – ein selbst signiertes Zertifikat wird dann abgelehnt", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    ctx.caPem = null;
    await expect(pair(code)).rejects.toThrow(/passt nicht zu der CA/);
  });

  it("falscher, abgelaufener, zurückgezogener Code; Adresse und Format werden vorher geprüft", async () => {
    await expect(pair("AAAA-BBBB-CCCC")).rejects.toThrow(PairingError);
    const old = await createPairingCode(h.db, "adm", SECRET, new Date(Date.now() - 25 * 3600_000));
    await expect(pair(old.code)).rejects.toThrow(/abgelaufen/);
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const [row] = await h.db.select().from(pairingCodes).where(eq(pairingCodes.lookup, pairingLookup(code)));
    await revokeCode(h.db, "adm", row!.id);
    await expect(pair(code)).rejects.toThrow(/unbekannt/);
    await expect(pairWithBackup({ backupUrl: "http://backup.test", code, instanceName: "x", mainUrl: "" })).rejects.toThrow(/https:\/\//);
    await expect(pairWithBackup({ backupUrl: url, code: "zu-kurz", instanceName: "x", mainUrl: "" })).rejects.toThrow(/Format/);
  });

  it("claim verlangt eine mit dem Code verschlüsselte Anfrage", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const lookup = pairingLookup(code);
    const wrong = seal(pairingKey("AAAA-BBBB-CCCC"), { nonce: "n", instanceName: "x", mainUrl: "", repoPassword: "x".repeat(30) }, aad.claim(lookup));
    await expect(pairingClaim(h.db, lookup, wrong, ctx)).rejects.toThrow(PairingRejected);
    const tooShort = seal(pairingKey(code), { nonce: "n", instanceName: "x", mainUrl: "", repoPassword: "kurz" }, aad.claim(lookup));
    await expect(pairingClaim(h.db, lookup, tooShort, ctx)).rejects.toThrow(/unvollständig/);
    const hello = await pairingHello(h.db, lookup, ctx);
    expect(open(pairingKey(code), hello!, aad.hello(lookup))).toEqual({ caPem: fx("ca.pem"), serverName: "Backup Lindenhof" });
  });

  it("Entkoppeln entfernt den rest-server-Zugang, das Repository bleibt", async () => {
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const p = await pair(code);
    await unpairInstance(h.db, "adm", p.instanceId, restDir);
    expect(readFileSync(path.join(restDir, ".htpasswd"), "utf8")).not.toContain(`${p.restUser}:`);
    expect((await listInstances(h.db)).map((i) => i.id)).not.toContain(p.instanceId);
    const [row] = await h.db.select().from(instances).where(eq(instances.id, p.instanceId));
    expect(row!.removedAt).toBeTruthy();
    expect(existsSync(restDir)).toBe(true);
  });
});

describe("Kopplungscode aus der Konfiguration (Installer, CI)", () => {
  it("wird einmal übernommen und koppelt wie ein Code aus der Web-UI", async () => {
    const h = await createTestDb();
    const code = "K7Q2-9MXA-4RT1";
    expect(await registerInitialCode(h.db, "kaputt", SECRET)).toBe("ungueltig");
    expect(await registerInitialCode(h.db, code, SECRET)).toBe("angelegt");
    expect(await registerInitialCode(h.db, code.toLowerCase(), SECRET)).toBe("bekannt");
    expect(await openCodes(h.db)).toHaveLength(1);
    const ctx = { appSecret: SECRET, caPem: null, serverName: "B", restDir: mkdtempSync(path.join(tmpdir(), "schulos-rest-")), restBaseUrl: "http://rest:8000" };
    expect(open(pairingKey(code), (await pairingHello(h.db, pairingLookup(code), ctx))!, aad.hello(pairingLookup(code)))).toMatchObject({ serverName: "B" });
    await h.close();
    rmSync(ctx.restDir, { recursive: true, force: true });
  });

  it("neue Instanz bekommt die Aufbewahrung aus dem Installer (SCHULOS_RETENTION)", async () => {
    const h = await createTestDb();
    const restDir = mkdtempSync(path.join(tmpdir(), "schulos-rest-"));
    await createUserWithPassword(h.db, { id: "adm", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: "x:y" });
    const retention = { retention: { daily: 14, weekly: 4, monthly: 6 }, reason: "Schulträger verlangt Halbjahresstände" };
    const ctx = { appSecret: SECRET, caPem: null, serverName: "B", restDir, restBaseUrl: "https://b/restic", retention };
    const { code } = await createPairingCode(h.db, "adm", SECRET);
    const lookup = pairingLookup(code);
    await pairingClaim(h.db, lookup, seal(pairingKey(code), { nonce: "n", instanceName: "Lindenhof", repoPassword: "repo-passwort-0123456789" }, aad.claim(lookup)), ctx);
    const [inst] = await h.db.select().from(instances);
    expect(inst).toMatchObject({ retention: retention.retention, retentionReason: retention.reason });
    await h.close();
    rmSync(restDir, { recursive: true, force: true });
  });
});

describe("Ersatz-Kopplung (neue Hardware)", () => {
  it("übernimmt die bestehende Instanz: neues Hauptsystem bekommt das alte Repository-Passwort, der alte Zugang wird ungültig", async () => {
    const h = await createTestDb();
    const restDir = mkdtempSync(path.join(tmpdir(), "schulos-rest-"));
    await createUserWithPassword(h.db, { id: "adm", username: "it.admin", firstName: "Ina", lastName: "Tech" }, { hash: "x:y" });
    const ctx = { appSecret: SECRET, caPem: null, serverName: "B", restDir, restBaseUrl: "https://b/restic" };
    // ursprüngliche Kopplung direkt über die Service-Funktionen
    const pairVia = async (code: string, repoPw: string) => {
      const lookup = pairingLookup(code);
      const key = pairingKey(code);
      const sealed = await pairingClaim(h.db, lookup, seal(key, { nonce: "n", instanceName: "Lindenhof", mainUrl: "https://neu", repoPassword: repoPw }, aad.claim(lookup)), ctx);
      return open<{ instanceId: string; restUser: string; restPassword: string; agentToken: string; repoPassword?: string }>(key, sealed!, aad.claimOk(lookup));
    };
    const first = await pairVia((await createPairingCode(h.db, "adm", SECRET)).code, "altes-repo-passwort-0123456789");
    expect(first.repoPassword).toBeUndefined();
    const before = readFileSync(path.join(restDir, ".htpasswd"), "utf8");

    const { code } = await createPairingCode(h.db, "adm", SECRET, new Date(), first.instanceId);
    const second = await pairVia(code, "neues-repo-passwort-wird-ignoriert-0");
    expect(second).toMatchObject({ instanceId: first.instanceId, restUser: first.restUser, repoPassword: "altes-repo-passwort-0123456789" });
    expect(second.agentToken).not.toBe(first.agentToken);
    expect(second.restPassword).not.toBe(first.restPassword);
    expect(readFileSync(path.join(restDir, ".htpasswd"), "utf8")).not.toBe(before); // neuer Hash für denselben Benutzer
    expect(await listInstances(h.db)).toHaveLength(1);
    const [inst] = await h.db.select().from(instances);
    expect(inst!.agentTokenHash).not.toBe(sha256Hex(first.agentToken));
    expect(inst!.mainUrl).toBe("https://neu");
    expect((await h.db.select().from(auditLog).where(eq(auditLog.action, "kopplung.ersatz")))).toHaveLength(1);
    // Wiederholung der Ersatz-Kopplung: dieselben neuen Zugangsdaten, weiterhin das bestehende Repository
    const repeated = await pairVia(code, "noch-ein-repo-passwort-0123456789");
    expect(repeated).toEqual({ ...second, nonce: "n" });
    expect(repeated).not.toHaveProperty("freshRepository");
    await h.close();
    rmSync(restDir, { recursive: true, force: true });
  });
});
