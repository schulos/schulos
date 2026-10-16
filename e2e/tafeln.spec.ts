import { expect, test } from "@playwright/test";
import { boardCount as count, collectErrors, collectExternal, drawRectangle, login } from "./helpers";

const BOARD = "tafel-7b-brueche";

// P3-12: zwei Browser auf derselben Tafel – Element-Updates per POST, Verteilung über den Live-Kanal (SSE, „tafel“)
test("P3-12: Lehrkraft und Schülerin zeichnen gleichzeitig auf derselben Tafel; Export PNG/SVG; nichts aus dem Netz", async ({ browser }) => {
  const teacherCtx = await browser.newContext({ acceptDownloads: true });
  const studentCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  const student = await studentCtx.newPage();
  const errors = [...collectErrors(teacher), ...collectErrors(student)];
  const external = [...collectExternal(teacher), ...collectExternal(student)];
  try {
    await login(teacher, "jana.brandt");
    await login(student, "lea.schaefer");
    await teacher.goto("/tafeln");
    await teacher.getByRole("link", { name: /Brüche/ }).click();
    await expect(teacher.getByRole("heading", { name: "Brüche", level: 1 })).toBeVisible();
    await student.goto(`/tafeln/${BOARD}`);
    // Beispieltafel: vier Elemente (Seed)
    await expect.poll(() => count(teacher)).toBe(4);
    await expect.poll(() => count(student)).toBe(4);

    await drawRectangle(teacher, 420, 120);
    await expect.poll(() => count(teacher)).toBe(5);
    await expect.poll(() => count(student), { timeout: 10_000 }).toBe(5);

    await drawRectangle(student, 420, 260);
    await expect.poll(() => count(teacher), { timeout: 10_000 }).toBe(6);
    await expect(teacher.getByRole("status").filter({ hasText: /Gespeichert/ })).toBeVisible();

    // gespeichert: neu laden zeigt den Stand vom Server, die Datei im Gruppenordner enthält beide Rechtecke
    await student.reload();
    await expect.poll(() => count(student)).toBe(6);
    await expect(async () => {
      const res = await teacher.request.get(`/api/dateien/${BOARD}`);
      expect(res.status()).toBe(200);
      const scene = (await res.json()) as { type: string; elements: { type: string; isDeleted: boolean }[] };
      expect(scene.type).toBe("excalidraw");
      expect(scene.elements.filter((e) => e.type === "rectangle" && !e.isDeleted)).toHaveLength(4);
    }).toPass();

    // Export clientseitig
    const [png] = await Promise.all([teacher.waitForEvent("download"), teacher.getByRole("button", { name: "Als PNG" }).click()]);
    expect(png.suggestedFilename()).toBe("Brüche.png");
    const [svg] = await Promise.all([teacher.waitForEvent("download"), teacher.getByRole("button", { name: "Als SVG" }).click()]);
    expect(svg.suggestedFilename()).toBe("Brüche.svg");
    const svgPath = await svg.path();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(svgPath, "utf8")).toContain("<svg");
    await teacher.screenshot({ path: ".data/shots/e2e/tafel.png", fullPage: true });

    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await teacherCtx.close();
    await studentCtx.close();
  }
});

test("P3-12: Tafel anlegen, im Gruppenordner wiederfinden; Nicht-Mitglieder und kaputte Anfragen", async ({ page }) => {
  await login(page, "daniel.okafor");
  expect((await page.goto(`/tafeln/${BOARD}`))?.status()).toBe(404);
  expect((await page.request.post(`/api/tafeln/${BOARD}/sync`, { data: {} })).status()).toBe(404);
  await page.goto("about:blank");
  await page.context().clearCookies();

  await login(page, "lea.schaefer");
  const api = `/api/tafeln/${BOARD}/update`;
  expect((await page.request.post(api, { headers: { "content-type": "text/plain" }, data: '{"elements":[]}' })).status()).toBe(415);
  expect((await page.request.post(api, { headers: { "sec-fetch-site": "cross-site" }, data: { elements: [] } })).status()).toBe(403);
  // unerlaubte Elemente (Bild, Web-Einbettung) werden einzeln verworfen, nicht das ganze Update (P312-01)
  const dropped = await page.request.post(api, { data: { elements: [{ id: "x", type: "image", version: 1, versionNonce: 1, isDeleted: false }, { id: "y", type: "embeddable", version: 1, versionNonce: 1, isDeleted: false }] } });
  expect(dropped.status()).toBe(200);
  expect(await dropped.json()).toMatchObject({ changed: 0, dropped: 2 });
  expect((await page.request.post(api, { data: { elements: [] } })).status()).toBe(400);
  expect((await page.request.post(api, { data: { elements: "x".repeat(600 * 1024) } })).status()).toBe(413);

  // Schülerin legt eine Tafel in ihrer Klasse an
  await page.goto("/tafeln");
  const form = page.getByRole("form", { name: "Neue Tafel" });
  await form.getByLabel("Titel").fill("Mindmap Wasser");
  await form.getByLabel("Gruppe").selectOption({ label: "Klasse 7b" });
  await form.getByRole("button", { name: "Tafel anlegen" }).click();
  await expect(page.getByRole("heading", { name: "Mindmap Wasser", level: 1 })).toBeVisible();
  await expect.poll(() => count(page)).toBe(0);
  // P312-01: Werkzeug „Web-Einbettung“ ist ausgeblendet (Rahmen bleibt); danach zeichnen und speichern geht normal
  await page.locator(".App-toolbar__extra-tools-trigger").click();
  await expect(page.getByTestId("toolbar-frame")).toBeVisible();
  const embed = page.getByTestId("toolbar-embeddable").first();
  await expect(embed).toContainText("Web-Einbettung");
  await expect(embed).toBeHidden();
  await page.keyboard.press("Escape");
  await drawRectangle(page, 500, 220); // rechts vom Eigenschaften-Feld
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();
  await expect.poll(() => count(page)).toBe(1);

  // G3B-05: die Bibliothek bleibt (Q-P312-5), „Bibliotheken durchsuchen“ (externe Seite mit der Schuladresse) ist ausgeblendet
  await page.locator(".default-sidebar-trigger").click();
  const browse = page.locator(".library-menu-browse-button");
  await expect(browse.first()).toBeAttached();
  expect(await browse.evaluateAll((els) => els.every((e) => getComputedStyle(e).display === "none"))).toBe(true);

  // G3B-01/02: Felder, an denen Excalidraw abstürzt (boundElementIds: 1, font: 1), bereinigt der Server – die Tafel öffnet
  // danach normal; eine Version jenseits der Grenze wird mit Kennung verworfen
  const boardId = new URL(page.url()).pathname.split("/").at(-1)!;
  const base = { versionNonce: 1, isDeleted: false, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, roughness: 1, opacity: 100 };
  const evil = await page.request.post(`/api/tafeln/${boardId}/update`, {
    data: {
      elements: [
        { ...base, id: "boese1", type: "rectangle", version: 1, index: "b0", x: 700, y: 100, width: 60, height: 40, boundElementIds: 1 },
        { ...base, id: "boese2", type: "text", version: 1, index: "b1", x: 700, y: 200, width: 60, height: 25, text: "Hallo", originalText: "Hallo", fontSize: 20, fontFamily: 5, lineHeight: 1.25, textAlign: "left", verticalAlign: "top", font: 1 },
        { ...base, id: "riesig", type: "rectangle", version: 9007199254740991, index: "b2", x: 0, y: 0, width: 5, height: 5 },
      ],
    },
  });
  expect(evil.status()).toBe(200);
  expect(await evil.json()).toMatchObject({ changed: 2, dropped: 1, droppedIds: ["riesig"] });
  await page.reload();
  await expect.poll(() => count(page)).toBe(3);
  await expect(page.getByRole("status").filter({ hasText: "Gespeichert" })).toBeVisible();

  // im Gruppenordner liegt sie als Datei und öffnet von dort als Tafel
  await page.goto("/dateien?bereich=group%3Ag-7b");
  await page.getByRole("link", { name: "Mindmap Wasser.excalidraw", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mindmap Wasser", level: 1 })).toBeVisible();
  await expect.poll(() => count(page)).toBe(3);
});

test("P3-12: Modul ausgeschaltet → Seite und API antworten mit 404", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/verwaltung/rechte");
  const toggle = page.getByRole("checkbox", { name: "Modul Tafeln", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(async () => {
    await page.reload();
    await expect(toggle).not.toBeChecked({ timeout: 1000 });
  }).toPass();
  try {
    expect((await page.goto("/tafeln"))?.status()).toBe(404);
    expect((await page.request.post(`/api/tafeln/${BOARD}/sync`, { data: {} })).status()).toBe(404);
  } finally {
    await page.goto("/verwaltung/rechte");
    await toggle.check();
    await expect(async () => {
      await page.reload();
      await expect(toggle).toBeChecked({ timeout: 1000 });
    }).toPass();
  }
  expect((await page.goto("/tafeln"))?.status()).toBe(200);
});
