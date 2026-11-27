import type pg from 'pg';
import { many, SCAN_INTERVAL_DAYS, SCAN_MAX_FAILURES, SCAN_RETRY_HOURS, withTransaction } from '@qbicle/platform';

/**
 * De planner zet scans in de wachtrij:
 * - een net bevestigd domein dat nog nooit gescand is: meteen (eerste scan);
 * - een domein van een klant met abonnement (proef, actief, achterstallig of
 *   opgezegd maar nog lopend): opnieuw als de laatste geslaagde scan ouder is
 *   dan het interval (standaard 7 dagen, "wekelijkse controle");
 * - na een mislukte scan: opnieuw na `retryHours`, hooguit `maxFailures` keer
 *   achter elkaar. Daarna wacht het domein tot iemand zelf een scan start.
 *
 * Alleen bevestigde domeinen die niet op de opt-outlijst staan.
 */

export interface PlannerOptions {
  intervalDays: number;
  retryHours: number;
  maxFailures: number;
}

/** Zelfde regels als wat de klant ziet (packages/platform/src/scanstatus.ts). */
export const DEFAULT_PLANNER: PlannerOptions = { intervalDays: SCAN_INTERVAL_DAYS, retryHours: SCAN_RETRY_HOURS, maxFailures: SCAN_MAX_FAILURES };

export interface PlannedScan {
  id: string;
  domain: string;
  reason: 'eerste' | 'periodiek' | 'na-fout';
}

/** Vaste sleutel voor het slot: twee workers plannen nooit tegelijk (geen dubbele scans). */
const PLANNER_LOCK = 0x51b1c1e;

export async function planScans(pool: pg.Pool, opts: PlannerOptions = DEFAULT_PLANNER, now = new Date()): Promise<PlannedScan[]> {
  return withTransaction(pool, async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [PLANNER_LOCK]);
    return many<PlannedScan>(
      q,
      `WITH stats AS (
         SELECT d.id, d.name,
                (SELECT max(s.finished_at) FROM scan s WHERE s.domain_id = d.id AND s.status = 'klaar' AND s.check_keys IS NULL) AS last_ok,
                (SELECT max(s.created_at) FROM scan s WHERE s.domain_id = d.id AND s.check_keys IS NULL) AS last_any,
                (SELECT count(*) FROM scan s WHERE s.domain_id = d.id AND s.status = 'mislukt' AND s.check_keys IS NULL
                    AND s.created_at > coalesce((SELECT max(k.finished_at) FROM scan k WHERE k.domain_id = d.id AND k.status = 'klaar' AND k.check_keys IS NULL), '-infinity')) AS failures,
                (SELECT s.status FROM scan s WHERE s.domain_id = d.id AND s.check_keys IS NULL ORDER BY s.created_at DESC LIMIT 1) AS last_status,
                EXISTS (SELECT 1 FROM subscription sub WHERE sub.organization_id = d.organization_id
                         AND sub.status IN ('proef', 'actief', 'achterstallig', 'opgezegd')) AS subscribed
           FROM domain d
          WHERE d.verified_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM scan_opt_out o WHERE o.name = d.name)
            AND NOT EXISTS (SELECT 1 FROM scan s WHERE s.domain_id = d.id AND s.status IN ('wachtrij', 'bezig'))
       ),
       due AS (
         SELECT id, name,
                CASE
                  WHEN last_status = 'mislukt' THEN
                    CASE WHEN failures < $4 AND last_any < $1::timestamptz - make_interval(hours => $3) THEN 'na-fout' END
                  WHEN last_ok IS NULL AND last_any IS NULL THEN 'eerste'
                  WHEN last_ok IS NULL THEN NULL
                  WHEN subscribed AND last_ok < $1::timestamptz - make_interval(days => $2) THEN 'periodiek'
                END AS reason
           FROM stats
       )
       INSERT INTO scan (domain_id, trigger, max_level)
       SELECT id, 'bewaking', 1 FROM due WHERE reason IS NOT NULL
       RETURNING id, (SELECT name FROM domain WHERE domain.id = scan.domain_id) AS domain,
                 (SELECT reason FROM due WHERE due.id = scan.domain_id) AS reason`,
      [now, opts.intervalDays, opts.retryHours, opts.maxFailures],
    );
  });
}
