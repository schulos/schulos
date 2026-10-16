import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// 1×1-PNG (rot)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

test.describe("Dateien", () => {
  test("Ordner anlegen, hochladen, Vorschau, umbenennen, löschen", async ({ page }) => {
    const errors = collectErrors(page);
    page.on("dialog", async (d) => {
      if (d.type() === "prompt") await d.accept(d.message().startsWith("Neuer") ? "Tafelbild-final.png" : "Mathe");
      else await d.accept();
    });
    await login(page, "lea.schaefer");
    await page.getByRole("link", { name: "Dateien", exact: true }).first().click();
    await expect(page.getByText("Dieser Ordner ist leer")).toBeVisible();

    await page.getByRole("button", { name: "Ordner" }).click();
    await page.getByRole("link", { name: "Mathe", exact: true }).click();
    await expect(page).toHaveURL(/ordner=/); // erst nach der Navigation hochladen
    await page.getByLabel("Dateien auswählen").setInputFiles([
      { name: "Tafelbild.png", mimeType: "image/png", buffer: PNG },
      { name: "Notizen.txt", mimeType: "text/plain", buffer: Buffer.from("Brüche kürzen") },
    ]);
    await expect(page.getByText("2 Dateien hochgeladen")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Pfad" })).toContainText("Meine Dateien");

    await page.getByRole("button", { name: "Tafelbild.png ansehen" }).click();
    await expect(page.getByRole("dialog").getByRole("img", { name: "Tafelbild.png" })).toBeVisible();
    await page.getByRole("button", { name: "Schließen" }).click();

    const dl = await page.request.get(await page.getByRole("link", { name: "Notizen.txt herunterladen" }).getAttribute("href") ?? "");
    expect(await dl.text()).toBe("Brüche kürzen");
    expect(dl.headers()["content-disposition"]).toContain("attachment");

    await page.getByRole("button", { name: "Tafelbild.png umbenennen" }).click();
    await expect(page.getByRole("link", { name: "Tafelbild-final.png", exact: true })).toBeVisible();
    await page.screenshot({ path: ".data/shots/e2e/dateien.png" });
    await page.getByRole("button", { name: "Notizen.txt löschen" }).click();
    await expect(page.getByRole("link", { name: "Notizen.txt", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Gruppenordner der Klasse: Lehrkraft lädt hoch, Schülerin sieht es, fremde Datei nicht löschbar; privat bleibt privat", async ({ page, browser }) => {
    await login(page, "jana.brandt");
    await page.goto("/dateien?bereich=group:g-7b");
    await page.getByLabel("Dateien auswählen").setInputFiles({ name: "Arbeitsblatt-Brüche.txt", mimeType: "text/plain", buffer: Buffer.from("AB") });
    await expect(page.getByText("1 Datei hochgeladen")).toBeVisible();

    const lea = await (await browser.newContext()).newPage();
    await login(lea, "lea.schaefer");
    await lea.goto("/dateien");
    await lea.getByRole("link", { name: "Klasse 7b" }).click();
    await expect(lea.getByRole("link", { name: "Arbeitsblatt-Brüche.txt", exact: true })).toBeVisible();
    await expect(lea.getByRole("button", { name: "Arbeitsblatt-Brüche.txt löschen" })).toHaveCount(0);
    expect((await lea.goto("/dateien?bereich=group:g-9a"))?.status()).toBe(404);
    await lea.context().close();
  });
});
