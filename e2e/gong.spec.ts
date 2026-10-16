import { expect, test } from "@playwright/test";
import { collectErrors, login } from "./helpers";

test("Gong: Benachrichtigung kommt live an und lässt sich als gelesen markieren", async ({ browser }) => {
  const leaCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const lea = await leaCtx.newPage();
  const admin = await adminCtx.newPage();
  const errors = collectErrors(lea);

  await login(lea, "lea.schaefer");
  await expect(lea.getByRole("button", { name: /Gong/ })).toBeVisible();
  const before = Number((await lea.getByTestId("gong-count").textContent({ timeout: 1000 }).catch(() => "0")) ?? 0);

  // Verwaltung legt eine Gruppe an und nimmt Lea auf
  await login(admin, "sabine.kowalski");
  await admin.goto("/verwaltung/gruppen/neu");
  await admin.getByLabel("Name", { exact: true }).fill("AG Sternwarte");
  await admin.getByLabel("Art", { exact: true }).selectOption("ag");
  await admin.getByRole("button", { name: "Anlegen" }).click();
  await admin.getByLabel("Mitglied hinzufügen").fill("lea.sch");
  await admin.getByRole("button", { name: "Lea Schäfer hinzufügen" }).click();
  await expect(admin.getByRole("heading", { name: "Mitglieder (1)" })).toBeVisible();

  // Leas Glocke aktualisiert sich ohne Neuladen (SSE)
  await expect(lea.getByTestId("gong-count")).toHaveText(String(before + 1), { timeout: 10_000 });
  await expect(lea.locator('[data-widget="heute.gruppen"]')).toContainText("AG Sternwarte");
  await lea.getByRole("button", { name: /Gong/ }).click();
  const item = lea.getByRole("button", { name: /Du bist jetzt in „AG Sternwarte“/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText("(ungelesen)");
  await lea.screenshot({ path: ".data/shots/e2e/gong.png" });

  await lea.getByRole("button", { name: "Alle gelesen" }).click();
  await expect(lea.getByTestId("gong-count")).toHaveCount(0);
  await expect(item).not.toContainText("(ungelesen)");
  expect(errors).toEqual([]);

  await leaCtx.close();
  await adminCtx.close();
});
