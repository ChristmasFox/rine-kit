import type { Pool } from 'pg';

export interface PublicPubgAdmission {
  acquire(signal?: AbortSignal): Promise<void>;
  observe(headers: Headers, status: number): Promise<void>;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('public_pubg_lookup_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('public_pubg_lookup_cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Public-only admission shared by app/worker connections. It spaces requests
 * conservatively rather than assuming a provider-aligned fixed minute window. */
export class PostgresPublicPubgAdmission implements PublicPubgAdmission {
  constructor(private readonly pool: Pool, private readonly requestsPerMinute = 10, private readonly maxWaitMs = 8000) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 1000
      || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 30_000) throw new Error('public_pubg_admission_config_invalid');
  }

  async tryAcquire(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO pubg_api_admission(quota_scope) VALUES ('public-pubg') ON CONFLICT DO NOTHING");
      const state = await client.query(
        `SELECT observed_limit,CEIL(EXTRACT(EPOCH FROM
         (GREATEST(next_request_at,COALESCE(blocked_until,next_request_at))-clock_timestamp()))*1000) AS wait_ms
         FROM pubg_api_admission WHERE quota_scope='public-pubg' FOR UPDATE`,
      );
      const wait = Math.max(0, Number(state.rows[0]?.wait_ms));
      if (wait === 0) {
        const observed = Number(state.rows[0]?.observed_limit);
        const limit = observed > 0 ? Math.min(observed, this.requestsPerMinute) : this.requestsPerMinute;
        await client.query(
          `UPDATE pubg_api_admission SET next_request_at=clock_timestamp()+($1::BIGINT*interval '1 millisecond'),reserved_at=clock_timestamp(),
           updated_at=now() WHERE quota_scope='public-pubg'`, [Math.ceil(60_000 / limit)],
        );
      }
      await client.query('COMMIT');
      return wait;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    while (!signal?.aborted) {
      const wait = await this.tryAcquire();
      if (wait === 0) return;
      if (wait > deadline - Date.now()) throw new Error('public_pubg_lookup_rate_limited');
      await delay(Math.max(1, Math.min(wait, 1000)), signal);
    }
    throw new Error('public_pubg_lookup_cancelled');
  }

  async observe(headers: Headers, status: number): Promise<void> {
    const rawLimit = headers.get('x-ratelimit-limit');
    const limit = rawLimit === null ? null : Number(rawLimit);
    const validLimit = limit !== null && Number.isSafeInteger(limit) && limit > 0 && limit <= 100_000 ? limit : null;
    const remaining = headers.get('x-ratelimit-remaining');
    let blockedUntil: Date | null = null;
    if (status === 429 || (remaining !== null && Number(remaining) === 0)) {
      const reset = Number(headers.get('x-ratelimit-reset')) * 1000;
      const retry = headers.get('retry-after');
      const retrySeconds = retry === null ? NaN : Number(retry);
      const retryAt = Number.isFinite(retrySeconds) ? Date.now() + retrySeconds * 1000 : Date.parse(retry ?? '');
      const providerReset = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 60_000;
      blockedUntil = new Date(Math.min(Date.now() + 24 * 60 * 60_000, Math.max(providerReset, Number.isFinite(retryAt) ? retryAt : 0)));
    }
    await this.pool.query(
      `UPDATE pubg_api_admission SET observed_limit=COALESCE($1,observed_limit),
       next_request_at=CASE WHEN $1::INTEGER IS NULL THEN next_request_at ELSE
         GREATEST(next_request_at,COALESCE(reserved_at,next_request_at)+($3::BIGINT*interval '1 millisecond')) END,
       blocked_until=CASE WHEN $2::TIMESTAMPTZ IS NULL THEN blocked_until ELSE GREATEST(COALESCE(blocked_until,$2),$2) END,
       updated_at=now() WHERE quota_scope='public-pubg'`, [validLimit, blockedUntil,validLimit?Math.ceil(60_000/Math.min(validLimit,this.requestsPerMinute)):0],
    );
  }
}
