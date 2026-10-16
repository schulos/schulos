/**
 * Wiederholt einen Versuch, solange der Fehler vorübergehend ist (`transient`, z. B. DNS/DHCP direkt nach dem Start des
 * Live-Systems). Andere Fehler (falscher Kopplungscode, Zertifikat) kommen sofort durch.
 */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  opts: { tries: number; delayMs: number; onRetry?: (err: Error, next: number) => void; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      const err = e as Error & { transient?: boolean };
      if (!err.transient || i >= opts.tries) throw err;
      opts.onRetry?.(err, i + 1);
      await sleep(opts.delayMs);
    }
  }
}
