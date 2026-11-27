import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { one } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { SCAN_COOLDOWN_MINUTES } from './scanstatus.ts';

type UserActor = Actor & { userId: string };

export interface ScanRequest {
  id: string;
  domainId: string;
  status: string;
  createdAt: Date;
}

/**
 * Zet een scan in de wachtrij. Alleen voor geverifieerde domeinen: zo scant
 * Qbicle vanuit een account nooit een domein waarvan niet is aangetoond dat het
 * van de klant is. De scan-worker (volgende fase) pakt rijen met status
 * 'wachtrij' op.
 */
export async function requestScan(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  domainId: string,
  opts: { maxLevel?: 0 | 1 } = {},
): Promise<ScanRequest> {
  await authorize(p.pool, actor.userId, organizationId, 'scans:starten');
  if (!isUuid(domainId)) throw notFound('Dit domein');
  const d = await one<{ id: string; name: string; verified_at: Date | null }>(
    p.pool,
    'SELECT id, name, verified_at FROM domain WHERE id = $1 AND organization_id = $2',
    [domainId, organizationId],
  );
  if (!d) throw notFound('Dit domein');
  if (!d.verified_at) {
    throw new PlatformError('niet_geverifieerd', 'Verifieer eerst dat dit domein van jullie is; daarna kun je het scannen.');
  }
  const optedOut = await one(p.pool, 'SELECT 1 FROM scan_opt_out WHERE name = $1', [d.name]);
  if (optedOut) throw new PlatformError('conflict', 'Voor dit domein is gevraagd het niet te scannen.');
  const running = await one<{ id: string; status: string; created_at: Date }>(
    p.pool,
    "SELECT id, status, created_at FROM scan WHERE domain_id = $1 AND status IN ('wachtrij', 'bezig') LIMIT 1",
    [d.id],
  );
  if (running) return { id: running.id, domainId: d.id, status: running.status, createdAt: running.created_at };

  const recent = await one<{ wacht: number }>(
    p.pool,
    `SELECT ceil(extract(epoch FROM max(created_at) + make_interval(mins => $2) - now()) / 60)::int AS wacht
       FROM scan WHERE domain_id = $1 AND status <> 'mislukt' HAVING max(created_at) > now() - make_interval(mins => $2)`,
    [d.id, SCAN_COOLDOWN_MINUTES],
  );
  if (recent) {
    throw new PlatformError(
      'te_veel_verzoeken',
      `Dit domein is net gescand. Over ${Math.max(1, recent.wacht)} ${recent.wacht === 1 ? 'minuut' : 'minuten'} kun je opnieuw een scan starten.`,
    );
  }
  await hit(p.pool, LIMITS.scanPerDomein, d.id);
  const s = await one<{ id: string; status: string; created_at: Date }>(
    p.pool,
    `INSERT INTO scan (domain_id, trigger, max_level, requested_by) VALUES ($1, 'handmatig', $2, $3)
     RETURNING id, status, created_at`,
    [d.id, opts.maxLevel ?? 1, actor.userId],
  );
  await audit(p.pool, actor, { organizationId, action: 'scan.aangevraagd', subject: s!.id, detail: { domein: d.name } });
  return { id: s!.id, domainId: d.id, status: s!.status, createdAt: s!.created_at };
}
