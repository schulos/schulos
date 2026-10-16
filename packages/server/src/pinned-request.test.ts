import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestJson, type RequestError } from "./pinned-request";

const fx = (f: string) => readFileSync(path.join(import.meta.dirname, "..", "test-fixtures", f), "utf8");

describe("requestJson mit gepinnter CA", () => {
  let server: https.Server;
  let base: string;

  beforeAll(async () => {
    server = https.createServer({ key: fx("localhost.key"), cert: fx("localhost.pem") }, (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/riesig") {
          // ohne Content-Length (chunked): die Grenze muss beim Lesen greifen; der Server hört nach dem Abbruch auf
          res.writeHead(200, { "content-type": "application/json" });
          const block = "x".repeat(64 * 1024);
          let sent = 0;
          const pump = () => {
            while (sent < 64 && !res.destroyed && res.write(block)) sent++;
            if (sent < 64 && !res.destroyed) res.once("drain", pump);
            else res.end();
          };
          res.on("error", () => {});
          return pump();
        }
        if (req.url === "/gross") {
          res.writeHead(200, { "content-type": "application/json", "content-length": 5_000_000 });
          return res.end();
        }
        res.writeHead(req.url === "/fehlt" ? 404 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, echo: body ? JSON.parse(body) : null }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("vertraut der gepinnten CA und schickt JSON", async () => {
    const r = await requestJson<{ method: string; echo: unknown }>(`${base}/x`, { method: "POST", body: { a: 1 }, trust: { mode: "ca", caPem: fx("ca.pem") } });
    expect(r).toEqual({ status: 200, body: { method: "POST", echo: { a: 1 } } });
    expect((await requestJson(`${base}/fehlt`, { trust: { mode: "ca", caPem: fx("ca.pem") } })).status).toBe(404);
  });

  it("lehnt eine fremde CA und den System-Truststore ab (eigene CA ist dort nicht bekannt)", async () => {
    await expect(requestJson(`${base}/x`, { trust: { mode: "ca", caPem: fx("other-ca.pem") } })).rejects.toMatchObject({ kind: "tls" } satisfies Partial<RequestError>);
    await expect(requestJson(`${base}/x`, { trust: { mode: "system" } })).rejects.toMatchObject({ kind: "tls" });
  });

  it("prüft den Hostnamen auch bei gepinnter CA", async () => {
    const port = new URL(base).port;
    // Zertifikat gilt für localhost und 127.0.0.1, nicht für 127.0.0.2
    await expect(requestJson(`https://127.0.0.2:${port}/x`, { trust: { mode: "ca", caPem: fx("ca.pem") } })).rejects.toBeTruthy();
  });

  it("insecure nimmt jedes Zertifikat (nur für das verschlüsselte hello)", async () => {
    expect((await requestJson(`${base}/x`, { trust: { mode: "insecure" } })).status).toBe(200);
  });

  it("bricht zu große Antworten ab (auch bei ungeprüftem TLS) – per Content-Length und beim Lesen", async () => {
    await expect(requestJson(`${base}/gross`, { trust: { mode: "insecure" } })).rejects.toMatchObject({ kind: "too_large" });
    await expect(requestJson(`${base}/riesig`, { trust: { mode: "insecure" } })).rejects.toMatchObject({ kind: "too_large" });
    await expect(requestJson(`${base}/riesig`, { trust: { mode: "insecure" }, maxBytes: 100 })).rejects.toThrow(/zu groß/);
    expect((await requestJson(`${base}/x`, { trust: { mode: "insecure" }, maxBytes: 100 })).status).toBe(200);
  });

  it("nicht erreichbar → network", async () => {
    await expect(requestJson("https://localhost:1/x", { trust: { mode: "system" }, timeoutMs: 2000 })).rejects.toMatchObject({ kind: "network" });
  });
});
