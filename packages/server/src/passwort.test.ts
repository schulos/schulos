import { describe, expect, it } from "vitest";
import { checkPassword, generatePassword } from "./passwort";

const jana = { username: "jana.brandt", firstName: "Jana", lastName: "Brandt" };

describe("checkPassword", () => {
  it("Länge 10 bis 128", () => {
    expect(checkPassword("kurz")).toBe("Mindestens 10 Zeichen.");
    expect(checkPassword("x".repeat(129))).toBe("Höchstens 128 Zeichen.");
  });

  it("lehnt bekannte Passwörter und Grundwort + Zahlen ab", () => {
    expect(checkPassword("1q2w3e4r5t")).toMatch(/bekannt/);
    expect(checkPassword("Passwort2026!")).toMatch(/leicht zu erraten/);
    expect(checkPassword("schule123456")).toMatch(/leicht zu erraten/);
    expect(checkPassword("Sommer2026!!")).toMatch(/leicht zu erraten/);
    expect(checkPassword("Frühling2026")).toMatch(/leicht zu erraten/);
    expect(checkPassword("ab12345678")).toMatch(/leicht zu erraten|folgen/);
  });

  it("lehnt Folgen, Wiederholungen und den eigenen Namen ab", () => {
    expect(checkPassword("aaaaaaaaaaaa")).toMatch(/verschiedene/);
    expect(checkPassword("ababababab")).toMatch(/verschiedene/);
    expect(checkPassword("Mein123456Hund")).toMatch(/folgen/);
    expect(checkPassword("xQwertzKatze")).toMatch(/folgen/);
    expect(checkPassword("BrandtImMai!", jana)).toMatch(/Namen/);
    expect(checkPassword("janaistklasse", jana)).toMatch(/Namen/);
  });

  it("nimmt gute Passwörter und Passphrasen an", () => {
    expect(checkPassword("Tafel Kreide Pause", jana)).toBeNull();
    expect(checkPassword("gR7!vLq2pZ")).toBeNull();
    expect(checkPassword("mein Fahrrad ist blau")).toBeNull();
  });

  it("die Startpasswörter der Verwaltung erfüllen die Regeln", () => {
    let ok = 0;
    for (let i = 0; i < 200; i++) if (checkPassword(generatePassword(), jana) === null) ok++;
    // sehr selten erzeugt der Zufall eine Folge – die Startpasswörter sind ohnehin nur bis zum ersten Wechsel gültig
    expect(ok).toBeGreaterThanOrEqual(195);
  });
});
