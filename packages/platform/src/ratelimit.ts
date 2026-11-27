import type { Queryable } from './db.ts';
import { PlatformError } from './errors.ts';
import { hashKey } from './tokens.ts';

export interface Limit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

/** Voorlopige limieten; bijstellen na de pilot. */
export const LIMITS = {
  inloglinkPerEmail: { bucket: 'inloglink-email', max: 5, windowSeconds: 3600 },
  inloglinkPerIp: { bucket: 'inloglink-ip', max: 20, windowSeconds: 3600 },
  inloggenPerIp: { bucket: 'inloggen-ip', max: 30, windowSeconds: 900 },
  uitnodigingPerOrg: { bucket: 'uitnodiging-org', max: 50, windowSeconds: 86400 },
  domeinPerOrg: { bucket: 'domein-org', max: 20, windowSeconds: 86400 },
  dnsCheckPerDomein: { bucket: 'dnscheck-domein', max: 10, windowSeconds: 3600 },
  verificatiemailPerDomein: { bucket: 'verificatiemail-domein', max: 5, windowSeconds: 86400 },
  scanPerDomein: { bucket: 'scan-domein', max: 6, windowSeconds: 86400 },
  hercontrolePerDomein: { bucket: 'hercontrole-domein', max: 30, windowSeconds: 86400 },
} as const satisfies Record<string, Limit>;

/**
 * Telt een poging en weigert als de limiet in het venster bereikt is.
 * Eenvoudig schuivend venster in PostgreSQL; geen extra dienst nodig.
 */
export async function hit(q: Queryable, limit: Limit, key: string): Promise<void> {
  const k = hashKey(key);
  const r = await q.query(
    `SELECT count(*)::int AS n FROM rate_limit_hit
      WHERE bucket = $1 AND key = $2 AND at > now() - make_interval(secs => $3)`,
    [limit.bucket, k, limit.windowSeconds],
  );
  if ((r.rows[0]?.n ?? 0) >= limit.max) {
    throw new PlatformError('te_veel_verzoeken', 'Te veel pogingen. Probeer het later opnieuw.');
  }
  await q.query('INSERT INTO rate_limit_hit (bucket, key) VALUES ($1, $2)', [limit.bucket, k]);
}

/** Oude tellingen weggooien (door de worker, bijv. elk uur). */
export async function pruneRateLimits(q: Queryable): Promise<number> {
  const r = await q.query(`DELETE FROM rate_limit_hit WHERE at < now() - interval '2 days'`);
  return r.rowCount ?? 0;
}
