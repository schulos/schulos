import { describe, expect, it } from "vitest";
import { INTERN_HEADER, internAllowed, internToken } from "@/intern";

describe("Interne API der Kommandozeile", () => {
  const secret = "geheimnis-0123456789abcdef";
  const h = (host: string, token?: string) => new Headers({ host, ...(token ? { [INTERN_HEADER]: token } : {}) });

  it("nur mit Token aus dem App-Geheimnis und nur über 127.0.0.1/localhost", () => {
    expect(internAllowed(h("127.0.0.1:3100", internToken(secret)), secret)).toBe(true);
    expect(internAllowed(h("localhost:3100", internToken(secret)), secret)).toBe(true);
    // über Caddy kommt der öffentliche Host-Header an
    expect(internAllowed(h("backup.schule.de", internToken(secret)), secret)).toBe(false);
    expect(internAllowed(h("127.0.0.1:3100", internToken("anderes-geheimnis")), secret)).toBe(false);
    expect(internAllowed(h("127.0.0.1:3100"), secret)).toBe(false);
    expect(internToken(secret)).not.toContain(secret);
  });
});
