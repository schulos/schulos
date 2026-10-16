import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDefaults, loadConfig, parseEnvFile, type Env } from "./config";

describe("Konfiguration", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), "schulos-config-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("liest KEY=VALUE mit Kommentaren und Anführungszeichen", () => {
    expect(
      parseEnvFile('# Kommentar\nSCHULOS_INSTANCE=demo\nSCHOOL_NAME="Gesamtschule \\"Am See\\""\nexport A=1 # Rest\nB=\'x # y\'\nkaputt\n\r\n'),
    ).toEqual({ SCHULOS_INSTANCE: "demo", SCHOOL_NAME: 'Gesamtschule "Am See"', A: "1", B: "x # y" });
  });

  it("Umgebung hat Vorrang vor der Datei", () => {
    const env: Env = { A: "env" };
    expect(applyDefaults(env, { A: "datei", B: "datei" })).toEqual(["B"]);
    expect(env).toEqual({ A: "env", B: "datei" });
  });

  it("ohne SCHULOS_CONFIG_DIR passiert nichts", () => {
    const env: Env = {};
    expect(loadConfig(env)).toEqual({ files: [], generatedSecret: false });
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it("lädt schulos.env und erzeugt das Geheimnis einmalig in secret.env", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "schulos.env"), "SCHULOS_INSTANCE=demo\n");
    const env1: Env = { SCHULOS_CONFIG_DIR: dir };
    const r1 = loadConfig(env1);
    expect(r1).toMatchObject({ files: ["schulos.env"], generatedSecret: true });
    expect(env1.SCHULOS_INSTANCE).toBe("demo");
    expect(env1.BETTER_AUTH_SECRET).toMatch(/^[\w-]{43}$/);
    // zweiter Start: dasselbe Geheimnis aus der Datei
    const env2: Env = { SCHULOS_CONFIG_DIR: dir };
    expect(loadConfig(env2)).toMatchObject({ files: ["schulos.env", "secret.env"], generatedSecret: false });
    expect(env2.BETTER_AUTH_SECRET).toBe(env1.BETTER_AUTH_SECRET);
    expect(readFileSync(path.join(dir, "secret.env"), "utf8").match(/BETTER_AUTH_SECRET=/g)).toHaveLength(1);
  });

  it("ein gesetztes Geheimnis wird nicht ersetzt", () => {
    const dir = tmp();
    const env: Env = { SCHULOS_CONFIG_DIR: dir, BETTER_AUTH_SECRET: "x".repeat(40) };
    expect(loadConfig(env).generatedSecret).toBe(false);
    expect(env.BETTER_AUTH_SECRET).toBe("x".repeat(40));
  });

  it("Kommandozeile (generateSecret: false) legt kein Geheimnis an – das macht nur der Server", () => {
    const dir = tmp();
    const env: Env = { SCHULOS_CONFIG_DIR: dir };
    expect(loadConfig(env, "backup.env", { generateSecret: false }).generatedSecret).toBe(false);
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(existsSync(path.join(dir, "secret.env"))).toBe(false);
  });
});
