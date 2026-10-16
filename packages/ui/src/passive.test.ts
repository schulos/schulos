import { describe, expect, it } from "vitest";
import { activityTracker, isPassiveRequest, PASSIVE_COOKIE, PASSIVE_HEADER, RECENT_INPUT_MS } from "./passive";

/** Attrappe für `document.cookie`: Setzen wie im Browser (ein Cookie je Zuweisung, `max-age=0` löscht). */
function fakeDocument() {
  const jar = new Map<string, string>();
  return {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(raw: string) {
      const [pair = "", ...attrs] = raw.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (attrs.some((a) => a.trim() === "max-age=0")) jar.delete(name.trim());
      else jar.set(name.trim(), value.trim());
    },
  };
}

describe("G4E-C01: automatisches Neuladen ist keine Aktivität", () => {
  it("Server: Cookie oder Kopfzeile kennzeichnen; ein Seitenaufruf zählt immer", () => {
    expect(isPassiveRequest(new Headers())).toBe(false);
    expect(isPassiveRequest(new Headers({ cookie: `a=b; ${PASSIVE_COOKIE}=1` }))).toBe(true);
    expect(isPassiveRequest(new Headers({ cookie: `${PASSIVE_COOKIE}=` }))).toBe(false);
    expect(isPassiveRequest(new Headers({ cookie: `x${PASSIVE_COOKIE}=1` }))).toBe(false);
    expect(isPassiveRequest(new Headers({ [PASSIVE_HEADER]: "1" }))).toBe(true);
    expect(isPassiveRequest(new Headers({ cookie: `${PASSIVE_COOKIE}=1`, "sec-fetch-mode": "navigate" }))).toBe(false);
    expect(isPassiveRequest(new Headers({ cookie: `${PASSIVE_COOKIE}=1`, "sec-fetch-mode": "cors" }))).toBe(true);
  });

  it("Browser: ohne Eingabe in der letzten Minute gekennzeichnet, eine Eingabe löscht das Kennzeichen sofort", () => {
    const doc = fakeDocument();
    let now = 1_000_000;
    const t = activityTracker(doc, () => now);
    // direkt nach dem Seitenaufruf: aktiv
    t.beforeAutomatic();
    expect(doc.cookie).toBe("");
    expect(t.headers()).toEqual({});
    // Tagesleiste lädt nach einer Minute ohne Eingabe neu
    now += RECENT_INPUT_MS;
    t.beforeAutomatic();
    expect(isPassiveRequest(new Headers({ cookie: doc.cookie }))).toBe(true);
    expect(t.headers()).toEqual({ [PASSIVE_HEADER]: "1" });
    // die Person klickt: vor der Anfrage ist das Kennzeichen weg
    t.input();
    expect(isPassiveRequest(new Headers({ cookie: doc.cookie }))).toBe(false);
    now += 10_000;
    t.beforeAutomatic();
    expect(doc.cookie).toBe("");
  });
});
