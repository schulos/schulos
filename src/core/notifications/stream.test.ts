import { describe, expect, it } from "vitest";
import { endLiveStreams, publish } from "./bus";
import { liveStream } from "./stream";

/** Liest den Strom bis zum Ende (oder bis `ms` vergangen sind) und liefert den Text. */
async function readAll(stream: ReadableStream<Uint8Array>, ms = 2_000): Promise<{ text: string; closed: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      await reader.cancel();
      return { text, closed: false };
    }
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
    if (chunk === null) continue;
    if (chunk.done) return { text, closed: true };
    text += decoder.decode(chunk.value);
  }
}

describe("Live-Strom (SEC-04)", () => {
  it("endet, sobald die Sitzung bei einem Ping nicht mehr gilt – danach keine Ereignisse mehr", async () => {
    let valid = true;
    const stream = liveStream({ userId: "u-strom-1", unread: 3, stillValid: async () => valid, pingMs: 20 });
    const reading = readAll(stream);
    publish("u-strom-1", { type: "read", unread: 2 });
    await new Promise((r) => setTimeout(r, 60));
    valid = false;
    await new Promise((r) => setTimeout(r, 60));
    publish("u-strom-1", { type: "read", unread: 99 });
    const { text, closed } = await reading;
    expect(closed).toBe(true);
    expect(text).toContain('event: hello\ndata: {"unread":3}');
    expect(text).toContain('"unread":2');
    expect(text).toContain(": ping");
    expect(text).not.toContain('"unread":99');
  });

  it("endet sofort bei Sperre/Reset/Abmeldung (endLiveStreams) – nur für diesen Benutzer", async () => {
    const mine = liveStream({ userId: "u-strom-2", unread: 0, stillValid: async () => true, pingMs: 60_000 });
    const other = liveStream({ userId: "u-strom-3", unread: 0, stillValid: async () => true, pingMs: 60_000 });
    const a = readAll(mine);
    const b = readAll(other, 300);
    endLiveStreams("u-strom-2");
    expect((await a).closed).toBe(true);
    expect((await b).closed).toBe(false);
  });

  it("hat eine Höchstdauer und endet, wenn die Prüfung selbst scheitert", async () => {
    expect((await readAll(liveStream({ userId: "u-strom-4", unread: 0, stillValid: async () => true, pingMs: 60_000, maxMs: 50 }))).closed).toBe(true);
    const failing = liveStream({ userId: "u-strom-5", unread: 0, stillValid: () => Promise.reject(new Error("DB weg")), pingMs: 20 });
    expect((await readAll(failing)).closed).toBe(true);
  });
});
