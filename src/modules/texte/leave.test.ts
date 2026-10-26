import { describe, expect, it } from "vitest";
import { hasUnconfirmedChanges, warnBeforeLeave } from "./leave";

describe("TD-06: Warnung beim Verlassen des Texte-Editors", () => {
  it("bestätigter Stand warnt nicht", () => {
    expect(hasUnconfirmedChanges("synced", false)).toBe(false);
    expect(hasUnconfirmedChanges("readonly", false)).toBe(false);
    expect(hasUnconfirmedChanges("removed", false)).toBe(false);
  });
  it("Speichern läuft oder ohne Verbindung: warnt", () => {
    expect(hasUnconfirmedChanges("pending", true)).toBe(true);
    expect(hasUnconfirmedChanges("offline", true)).toBe(true);
  });
  it("abgelehnte Änderung: warnt", () => {
    expect(hasUnconfirmedChanges({ error: "Die Änderung wurde abgelehnt." }, false)).toBe(true);
  });
  it("Rest in der Warteschlange warnt auch bei Status „gespeichert“", () => {
    expect(hasUnconfirmedChanges("synced", true)).toBe(true);
  });
});

describe("Review R3 N3: Rückfrage beim Verlassen", () => {
  const event = () => ({
    prevented: false,
    returnValue: undefined as unknown,
    preventDefault() {
      this.prevented = true;
    },
  });
  it("unbestätigt: preventDefault und returnValue gesetzt (ältere Browser fragen nur mit returnValue)", () => {
    const e = event();
    warnBeforeLeave(e as unknown as BeforeUnloadEvent, true);
    expect(e.prevented).toBe(true);
    expect(e.returnValue).toBe("");
  });
  it("bestätigt: keine Rückfrage", () => {
    const e = event();
    warnBeforeLeave(e as unknown as BeforeUnloadEvent, false);
    expect(e.prevented).toBe(false);
    expect(e.returnValue).toBeUndefined();
  });
});
