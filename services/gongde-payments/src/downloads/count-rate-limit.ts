/** Bounded, process-local protection for optional download-event writes.
 * A rejected count never blocks the installer redirect. Multi-instance and
 * distributed traffic still require an edge/shared limiter. */
export class DownloadCountRateLimit {
  readonly #clients = new Map<string, { until: number; count: number }>();
  #global = { until: 0, count: 0 };
  constructor(private readonly windowMs = 60_000, private readonly perClient = 20,
    private readonly globalLimit = 1_000, private readonly maxClients = 4_096) {}

  allow(key: string, now = Date.now()): boolean {
    if (!key || !Number.isFinite(now)) return false;
    if (now >= this.#global.until) this.#global = { until: now + this.windowMs, count: 0 };
    if (this.#global.count >= this.globalLimit) return false;
    let client = this.#clients.get(key);
    if (client && now >= client.until) { this.#clients.delete(key); client = undefined; }
    if (!client) {
      // Insertion order tracks expiry: existing windows are never extended.
      while (this.#clients.size >= this.maxClients) {
        const oldest = this.#clients.entries().next().value as [string, { until: number; count: number }] | undefined;
        if (!oldest || oldest[1].until > now) return false;
        this.#clients.delete(oldest[0]);
      }
      client = { until: now + this.windowMs, count: 0 }; this.#clients.set(key, client);
    }
    if (client.count >= this.perClient) return false;
    client.count++; this.#global.count++; return true;
  }
}
