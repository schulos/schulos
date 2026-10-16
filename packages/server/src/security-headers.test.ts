import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, STATIC_SECURITY_HEADERS } from "./security-headers";

describe("Sicherheits-Header", () => {
  it("CSP: Skripte nur mit Nonce, keine Einbettung von außen, kein eval in Produktion", () => {
    const csp = contentSecurityPolicy("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(contentSecurityPolicy("x", true)).toContain("'unsafe-eval'");
  });

  it("feste Header", () => {
    const h = Object.fromEntries(STATIC_SECURITY_HEADERS.map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=\d+/);
  });
});
