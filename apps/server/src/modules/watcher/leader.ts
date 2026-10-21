// One scanner per chain across all watcher processes: a session-level Postgres advisory lock held on a dedicated
// connection. If that connection dies the lock is released and another process takes over with a higher epoch; the old
// leader's next write is fenced out by the epoch check in scanTick (D-017).
import pg from 'pg';

export class AdvisoryLock {
  private client: pg.Client | null = null;

  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  /** True if this process now holds the lock (or already did). */
  async acquire(): Promise<boolean> {
    if (!this.client) {
      const c = new pg.Client({ connectionString: this.url });
      c.on('error', () => {
        this.client = null; // connection lost = lock lost
      });
      await c.connect();
      this.client = c;
    }
    const r = await this.client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [this.key]);
    return r.rows[0]?.ok === true;
  }

  /** The lock lives exactly as long as the connection; a round trip proves both. */
  async held(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }
}
