import { describe, expect, it } from "vitest";
import { checkedAfter, formValues, listAfter } from "./form-values";

describe("formValues", () => {
  it("Textfelder ja, interne Felder und Dateien nein", () => {
    const f = new FormData();
    f.set("title", "Elternabend");
    f.set("$ACTION_ID_abc", "");
    f.set("pinned", "on");
    f.set("file", new Blob(["x"]), "a.txt");
    expect(formValues(f)).toEqual({ title: "Elternabend", pinned: "on" });
  });

  it("Kontrollkästchen: nach Fehler wie abgeschickt, sonst Vorgabe", () => {
    expect(checkedAfter(undefined, "pinned", true)).toBe(true);
    expect(checkedAfter({ title: "x" }, "pinned", true)).toBe(false);
    expect(checkedAfter({ pinned: "on" }, "pinned", false)).toBe(true);
  });

  it("Mehrfachauswahl bleibt nach einem Fehler erhalten (Code-Review Gate 4a N1)", () => {
    const f = new FormData();
    f.set("title", "Wartung");
    for (const r of ["106", "112", "NW2"]) f.append("roomIds", r);
    const v = formValues(f);
    expect(v.roomIds).toBe("NW2");
    expect(listAfter(v, "roomIds", [])).toEqual(["106", "112", "NW2"]);
    const one = new FormData();
    one.set("roomIds", "106");
    expect(listAfter(formValues(one), "roomIds", ["x"])).toEqual(["106"]);
    expect(listAfter({ title: "x" }, "roomIds", ["x"])).toEqual([]);
    expect(listAfter(undefined, "roomIds", ["x"])).toEqual(["x"]);
  });
});
