import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readBody } from "@/modules/tafeln/body";
import { readJsonBody } from "./json-body";

// Gemeinsamer JSON-Body (Texte P3-11, Tafeln P3-12) – hier mit Grenze und Meldung der Tafeln (Review P312, Testlücke).

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/tafeln/x/update", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

const answer = async (r: Record<string, unknown> | Response) => (r instanceof Response ? { status: r.status, ...((await r.json()) as object), cache: r.headers.get("cache-control") } : r);

describe("core/json-body", () => {
  it("Reihenfolge der Prüfungen: Origin (403) vor Typ (415) vor Größe (413) vor Inhalt (400)", async () => {
    const big = String(MAX_BODY_BYTES + 1);
    expect(await answer(await readBody(post("kaputt", { "sec-fetch-site": "cross-site", "content-type": "text/plain", "content-length": big })))).toMatchObject({ status: 403 });
    expect(await answer(await readBody(post("kaputt", { "content-type": "text/plain", "content-length": big })))).toMatchObject({ status: 415 });
    expect(await answer(await readBody(post("kaputt", { "content-length": big })))).toMatchObject({ status: 413 });
    expect(await answer(await readBody(post("kaputt")))).toMatchObject({ status: 400, error: "Ungültige Anfrage" });
  });

  it("Tafeln: Grenze 512 KB + Rahmen, eigene Meldung; gezählt werden Bytes, nicht Zeichen", async () => {
    expect(MAX_BODY_BYTES).toBe(512 * 1024 + 1024);
    const tooBig = await answer(await readBody(post(`{"elements":"${"x".repeat(MAX_BODY_BYTES)}"}`)));
    expect(tooBig).toEqual({ status: 413, error: "Die Änderung ist zu groß (höchstens 512 KB auf einmal)", cache: "private, no-store" });
    // knapp über der Hälfte in Zeichen, aber zweibytig → über der Grenze
    const umlauts = "ä".repeat(Math.ceil(MAX_BODY_BYTES / 2) + 10);
    expect(await answer(await readBody(post(`{"t":"${umlauts}"}`)))).toMatchObject({ status: 413 });
    const fits = "x".repeat(MAX_BODY_BYTES - 20);
    expect(await readBody(post(`{"t":"${fits}"}`))).toEqual({ t: fits });
  });

  it("Standardmeldung und Objektpflicht", async () => {
    expect(await answer(await readJsonBody(post("{}", { "content-length": "11" }), 10))).toMatchObject({ status: 413, error: "Die Änderung ist zu groß" });
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ a: 1 });
    for (const bad of ["[]", "null", '"text"', "1"]) expect(await answer(await readJsonBody(post(bad), 100))).toMatchObject({ status: 400 });
  });
});
