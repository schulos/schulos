import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

// Eigenes Kind anlegen statt Seed-Schüler:innen zu ändern – andere Specs zählen Eltern der Klasse 7b.
test("P4-38: Elternkonto zu einem Kind anlegen, vorhandenes verknüpfen, Verknüpfung lösen", async ({ page }) => {
  const errors = collectErrors(page);
  await login(page, "sabine.kowalski");
  await page.goto("/verwaltung/benutzer/neu");
  await page.getByLabel("Vorname").fill("Pia");
  await page.getByLabel("Nachname").fill("Elternprobe");
  await page.getByLabel("Rolle").selectOption("schueler");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Benutzer angelegt")).toBeVisible();
  await page.goto("/verwaltung/benutzer?q=elternprobe");
  await page.getByRole("link", { name: /Elternprobe, Pia/ }).click();

  const card = page.getByRole("article", { name: "Eltern" });
  await expect(card).toContainText("Kein Elternkonto verknüpft");
  await card.getByRole("button", { name: "Neues Elternkonto anlegen …" }).click();
  const neu = card.getByRole("form", { name: "Neues Elternkonto" });
  await neu.getByLabel("Vorname").fill("Olga");
  await neu.getByLabel("Nachname").fill("Elternprobe");
  await neu.getByLabel("E-Mail-Adresse (optional)").fill("olga.p438@example.org");
  await neu.getByRole("button", { name: "Elternkonto anlegen und verknüpfen" }).click();
  await expect(card.getByText("Elternkonto angelegt")).toBeVisible();
  await expect(card.getByTestId("cred-username")).toHaveText("olga.elternprobe");
  await expect(card.getByRole("link", { name: "Olga Elternprobe" })).toBeVisible();

  // lösen und über den Benutzernamen wieder verknüpfen
  page.once("dialog", (d) => void d.accept());
  await card.getByRole("button", { name: "Verknüpfung mit Olga Elternprobe lösen" }).click();
  await expect(card).toContainText("Kein Elternkonto verknüpft");
  const link = card.getByRole("form", { name: "Elternkonto verknüpfen" });
  await link.getByLabel("Vorhandenes Elternkonto verknüpfen").fill("jana.brandt");
  await link.getByRole("button", { name: "Verknüpfen" }).click();
  await expect(link.getByText("Kein Elternkonto mit diesem Benutzernamen")).toBeVisible();
  await link.getByLabel("Vorhandenes Elternkonto verknüpfen").fill("olga.elternprobe");
  await link.getByRole("button", { name: "Verknüpfen" }).click();
  await expect(card.getByRole("link", { name: "Olga Elternprobe" })).toBeVisible();

  // auf der Seite des Elternkontos erscheint das Kind
  await card.getByRole("link", { name: "Olga Elternprobe" }).click();
  await expect(page.getByRole("article", { name: "Kinder" })).toContainText("Pia Elternprobe");
  await expect(page.getByLabel("E-Mail-Adresse", { exact: true })).toHaveValue("olga.p438@example.org");
  expect(errors).toEqual([]);
});
