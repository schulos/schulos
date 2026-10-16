import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";
import { isAuthApiError } from "./auth-errors";

describe("isAuthApiError", () => {
  it("erkennt echte Better-Auth-Fehler", () => {
    expect(isAuthApiError(new APIError("UNAUTHORIZED", { message: "x" }))).toBe(true);
  });
  it("erkennt strukturgleiche Fehler aus einer anderen Bundle-Schicht", () => {
    const foreign = Object.assign(new Error("x"), { name: "APIError", status: "FORBIDDEN" });
    expect(isAuthApiError(foreign)).toBe(true);
  });
  it("ignoriert andere Fehler", () => {
    expect(isAuthApiError(new Error("boom"))).toBe(false);
    expect(isAuthApiError(null)).toBe(false);
    expect(isAuthApiError("APIError")).toBe(false);
  });
});
