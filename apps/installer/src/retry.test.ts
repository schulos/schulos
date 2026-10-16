import { describe, expect, it } from "vitest";
import { retryTransient } from "./retry";

const transient = (m: string) => Object.assign(new Error(m), { transient: true });
const noSleep = async () => {};

describe("retryTransient", () => {
  it("wiederholt vorübergehende Fehler, bis es klappt", async () => {
    let n = 0;
    const retries: number[] = [];
    const r = await retryTransient(
      async () => {
        if (++n < 3) throw transient("EAI_AGAIN");
        return "ok";
      },
      { tries: 5, delayMs: 1, sleep: noSleep, onRetry: (_, next) => retries.push(next) },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(retries).toEqual([2, 3]);
  });

  it("gibt nach der letzten Wiederholung den Fehler weiter", async () => {
    let n = 0;
    await expect(
      retryTransient(
        async () => {
          n++;
          throw transient("EAI_AGAIN");
        },
        { tries: 4, delayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("EAI_AGAIN");
    expect(n).toBe(4);
  });

  it("wiederholt andere Fehler nicht (z. B. falscher Kopplungscode)", async () => {
    let n = 0;
    await expect(
      retryTransient(
        async () => {
          n++;
          throw new Error("Kopplungscode unbekannt");
        },
        { tries: 5, delayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow("unbekannt");
    expect(n).toBe(1);
  });
});
