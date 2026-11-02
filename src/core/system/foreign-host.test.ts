import { describe, expect, it } from "vitest";
import { foreignHost } from "./foreign-host";

describe("foreignHost (Anmeldeseite: Aufruf per IP/Fremdname)", () => {
  const base = "https://schulos.gs-musterstadt.de";

  it("gleicher Name – auch mit anderem Port oder anderer Schreibweise – kein Hinweis", () => {
    expect(foreignHost("schulos.gs-musterstadt.de", base)).toBeNull();
    expect(foreignHost("SchulOS.gs-musterstadt.de:443", base)).toBeNull();
    expect(foreignHost("localhost:3000", "https://localhost:8443")).toBeNull();
  });

  it("IP-Adresse oder Rechnername: Hinweis mit der Anmeldeseite unter der eingerichteten Adresse", () => {
    expect(foreignHost("192.0.2.10", base)).toEqual({ host: "192.0.2.10", origin: base, loginUrl: `${base}/login` });
    expect(foreignHost("schulserver.local:443", base)?.loginUrl).toBe(`${base}/login`);
    expect(foreignHost("[2001:db8::1]:8443", "https://localhost:8443")).toEqual({ host: "[2001:db8::1]:8443", origin: "https://localhost:8443", loginUrl: "https://localhost:8443/login" });
  });

  it("ohne Host, ohne oder mit unlesbarer eingerichteter Adresse: kein Hinweis", () => {
    expect(foreignHost(null, base)).toBeNull();
    expect(foreignHost("192.0.2.10", undefined)).toBeNull();
    expect(foreignHost("192.0.2.10", "kein url")).toBeNull();
    expect(foreignHost("a b", base)).toBeNull();
  });
});
