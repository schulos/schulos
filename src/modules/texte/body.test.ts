import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readBody } from "./body";

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/texte/x/update", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

const status = async (r: Record<string, unknown> | Response) => (r instanceof Response ? r.status : "ok");

describe("Texte – Body der API (P311-05)", () => {
  it("nimmt JSON-Objekte an", async () => {
    expect(await readBody(post('{"update":"AAAA"}'))).toEqual({ update: "AAAA" });
    expect(await readBody(post("{}", { "content-type": "application/json; charset=utf-8" }))).toEqual({});
    expect(await readBody(post("{}", { "sec-fetch-site": "same-origin" }))).toEqual({});
  });

  it("CSRF: nur application/json, nur von derselben Origin (wenn der Browser es sagt)", async () => {
    expect(await status(await readBody(post('{"update":"AAAA"}', { "content-type": "text/plain" })))).toBe(415);
    expect(await status(await readBody(new Request("http://localhost/x", { method: "POST", body: "{}" })))).toBe(415);
    expect(await status(await readBody(post("{}", { "sec-fetch-site": "cross-site" })))).toBe(403);
    expect(await status(await readBody(post("{}", { "sec-fetch-site": "same-site" })))).toBe(403);
    expect(await status(await readBody(post("{}", { "sec-fetch-site": "none" })))).toBe(403);
  });

  it("zu groß (Header oder tatsächlich) → 413, kein Objekt → 400", async () => {
    expect(await status(await readBody(post("{}", { "content-length": String(MAX_BODY_BYTES + 1) })))).toBe(413);
    expect(await status(await readBody(post(`{"update":"${"A".repeat(MAX_BODY_BYTES)}"}`)))).toBe(413);
    expect(await status(await readBody(post("nicht json")))).toBe(400);
    expect(await status(await readBody(post("[1,2]")))).toBe(400);
    expect(await status(await readBody(post("null")))).toBe(400);
  });
});
