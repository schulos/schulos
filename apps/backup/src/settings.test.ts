import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rootCaInfo } from "@schulos/server/root-ca";
import { tlsRootCa } from "./settings";

const fixtures = path.join(import.meta.dirname, "../../../packages/server/test-fixtures");

describe("CA-05: Root des Backupservers für den Download", () => {
  it("nur mit eigener CA (Datei vorhanden, CA-Zertifikat), sonst null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "backup-ca-"));
    try {
      const file = path.join(dir, "root.crt");
      expect(tlsRootCa({})).toBeNull();
      expect(tlsRootCa({ SCHULOS_TLS_CA_FILE: file })).toBeNull();
      const ca = readFileSync(path.join(fixtures, "ca.pem"), "utf8");
      writeFileSync(file, ca);
      expect(tlsRootCa({ SCHULOS_TLS_CA_FILE: file })?.info).toEqual(rootCaInfo(ca));
      writeFileSync(file, "kein Zertifikat");
      expect(tlsRootCa({ SCHULOS_TLS_CA_FILE: file })).toBeNull();
      writeFileSync(file, readFileSync(path.join(fixtures, "localhost.pem")));
      expect(tlsRootCa({ SCHULOS_TLS_CA_FILE: file })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
