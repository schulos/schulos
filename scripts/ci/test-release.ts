// Signiertes Test-Release für den Update-Test (B-39, scripts/update-test.sh): Manifest wie im Release-Workflow, signiert mit
// einem Wegwerf-Schlüssel (ECDSA P-256 über SHA-256 – dasselbe Format wie `cosign sign-blob`). schulosctl prüft dagegen
// mit SCHULOS_RELEASE_KEY=<ordner>/test.pub.
//   npx tsx scripts/ci/test-release.ts --keys <ordner> --out <ordner>/v1.0.1 --version 1.0.1 --app <ref@sha256> --agent <ref@sha256>
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildManifest } from "../../packages/server/src/release";

const { values: v } = parseArgs({
  options: { keys: { type: "string" }, out: { type: "string" }, version: { type: "string" }, app: { type: "string" }, agent: { type: "string" } },
});
if (!v.keys || !v.out || !v.version || !v.app || !v.agent) throw new Error("--keys, --out, --version, --app, --agent angeben");

mkdirSync(v.keys, { recursive: true });
const priv = path.join(v.keys, "test.key");
if (!existsSync(priv)) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(path.join(v.keys, "test.pub"), publicKey.export({ type: "spki", format: "pem" }));
}
const manifest = buildManifest({
  version: v.version,
  notes: { betaDays: 0, changes: [{ kind: "behoben", text: `Update-Test ${v.version}` }] },
  images: { app: v.app, backup: v.app, agent: v.agent },
  commit: "0000000",
  publishedAt: new Date(Date.now() - 60_000),
});
mkdirSync(v.out, { recursive: true });
const data = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(path.join(v.out, "release.json"), data);
writeFileSync(path.join(v.out, "release.json.sig"), sign("sha256", data, createPrivateKey(readFileSync(priv))).toString("base64"));
console.log(`Test-Release ${manifest.version} signiert`);
