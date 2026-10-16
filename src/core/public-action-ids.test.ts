import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { EXTERN_HEADER } from "./external-access";
import { externalActionAllowed, parsePublicActionIds, publicActionIds } from "./public-action-ids";

const PUB = "70" + "ab".repeat(20);
const LOGIN = "60" + "cd".repeat(20);
const PUB_LINUX = "71" + "ab".repeat(20);
const LOGIN_LINUX = "61" + "cd".repeat(20);
const manifest = {
  node: {
    [PUB]: { workers: {}, filename: "../D:\\GitHub\\schulos\\src\\modules\\anmeldung\\public-actions.ts", exportedName: "submitAntragAction" },
    [LOGIN]: { workers: {}, filename: "/app/src/app/(auth)/login/actions.ts", exportedName: "loginAction" },
    // Linux-Build (CI/Release): Pfade relativ zu src/
    [PUB_LINUX]: { workers: {}, filename: "modules/anmeldung/public-actions.ts", exportedName: "freeSlotsAction" },
    [LOGIN_LINUX]: { workers: {}, filename: "app/(auth)/login/actions.ts", exportedName: "loginAction" },
    "abcdefabcdefabcdefabcdefabcdefabcdefabcd01": { filename: "x/modules/anmeldung/public-actions.ts" },
    // ähnlicher Name, aber nicht die öffentliche Datei
    "1234567890abcdef1234567890abcdef12345678aa": { filename: "/app/src/modules/anmeldung/public-actions.ts.bak" },
    kaputt: { filename: "/app/src/modules/anmeldung/public-actions.ts" },
  },
  edge: {},
};

describe("Server Actions von außen (GATE-4c)", () => {
  it("nur IDs aus den öffentlichen Action-Dateien (Windows- und Linux-Pfade)", () => {
    expect([...parsePublicActionIds(manifest)].sort()).toEqual([PUB, PUB_LINUX].sort());
    expect(parsePublicActionIds(null).size).toBe(0);
    expect(parsePublicActionIds({ node: "x" }).size).toBe(0);
  });

  it("ohne Next-Action erlaubt, sonst nur bekannte öffentliche IDs; ohne Manifest keine (geschlossen)", () => {
    const ids = parsePublicActionIds(manifest);
    expect(externalActionAllowed(null, ids)).toBe(true);
    expect(externalActionAllowed(PUB, ids)).toBe(true);
    expect(externalActionAllowed(LOGIN, ids)).toBe(false);
    expect(externalActionAllowed(PUB_LINUX, ids)).toBe(true);
    expect(externalActionAllowed(LOGIN_LINUX, ids)).toBe(false);
    expect(publicActionIds("/gibt/es/nicht.json").has(PUB)).toBe(false);
  });

  it("Proxy: POST von außen mit fremder Action-ID auf /anmeldung → 403; im Schulnetz unberührt", () => {
    const post = (headers: Record<string, string>) => proxy(new NextRequest(new URL("/anmeldung", "https://schulos.test"), { method: "POST", headers }));
    expect(post({ [EXTERN_HEADER]: "1", "next-action": LOGIN }).status).toBe(403);
    expect(post({ [EXTERN_HEADER]: "1" }).status).toBe(200);
    expect(post({ "next-action": LOGIN }).status).toBe(200);
  });
});
