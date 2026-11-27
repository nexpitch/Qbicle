import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type pg from 'pg';
import { many, one, withTransaction, type Mailer } from '@qbicle/platform';
import { recordError } from '@qbicle/ops';
import { DomainNotFoundError, OptOutError, scanDomain, type Net, type ScanReport } from '@qbicle/scanner';
import { StaleScanError, storeScanReport, type ScanJob, type StoreResult } from './store.ts';

/**
 * De scan-worker pakt scans uit de wachtrij (tabel scan, status 'wachtrij'),
 * draait de passieve scanner en slaat het resultaat op.
 *
 * Scangrenzen: alleen de bestaande scanner (niveau 0 en 1: DNS, één TLS-verbinding,
 * de homepage en security.txt). Geen poortscans, geen kwetsbaarheden uitproberen.
 * Actief scannen van een netwerk vraagt een getekende scanopdracht en zit hier
 * bewust niet in. Een domein wordt alleen gescand als het op dat moment nog
 * bevestigd is en niet op de opt-outlijst staat.
 */

export interface WorkerContext {
  pool: pg.Pool;
  net: Net;
  workerId: string;
  /** Na zoveel minuten breekt de worker een scan af en markeert hem als mislukt. */
  timeoutMinutes: number;
  /** Extra opt-outlijst uit een bestand (naast tabel scan_opt_out). */
  optOut?: Set<string>;
  /** Na de eerste scan van een domein mailen we eigenaren en beheerders. Zonder mailer: geen mail. */
  mailer?: Mailer;
  /** Adres van de klantomgeving, voor de link in de mail. */
  appOrigin?: string;
  /** Voor tests: een andere scanner. */
  scan?: typeof scanDomain;
  log?: (msg: string) => void;
}

export function newWorkerId(): string {
  return `${hostname().slice(0, 60)}:${process.pid}:${randomBytes(3).toString('hex')}`;
}

/** Pakt de oudste scan uit de wachtrij; twee workers pakken nooit dezelfde. */
export async function claimNextScan(pool: pg.Pool, workerId: string): Promise<ScanJob | null> {
  const r = await one<{ id: string; domain_id: string; domain_name: string; organization_id: string; max_level: number; attempts: number }>(
    pool,
    `WITH next AS (
       SELECT id FROM scan WHERE status = 'wachtrij' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE scan s SET status = 'bezig', started_at = now(), finished_at = NULL, claimed_by = $1
       FROM next, domain d
      WHERE s.id = next.id AND d.id = s.domain_id
     RETURNING s.id, s.domain_id, d.name AS domain_name, d.organization_id, s.max_level, s.attempts`,
    [workerId],
  );
  if (!r) return null;
  return {
    id: r.id,
    domainId: r.domain_id,
    domainName: r.domain_name,
    organizationId: r.organization_id,
    maxLevel: r.max_level === 0 ? 0 : 1,
    attempts: r.attempts,
    claimedBy: workerId,
  };
}

/** Fout die we aan de klant kunnen uitleggen; geen storing van Qbicle zelf. */
class ExpectedScanError extends Error {}

async function failScan(ctx: WorkerContext, job: ScanJob, message: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE scan SET status = 'mislukt', finished_at = now(), error = $3
      WHERE id = $1 AND status = 'bezig' AND claimed_by = $2`,
    [job.id, job.claimedBy, message.slice(0, 2000)],
  );
}

function withTimeout<T>(p: Promise<T>, minutes: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Scan duurde langer dan ${minutes} minuten en is afgebroken.`)), minutes * 60_000);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export type JobOutcome = { status: 'klaar'; result: StoreResult } | { status: 'mislukt'; error: string } | { status: 'overgeslagen' };

export async function runScanJob(ctx: WorkerContext, job: ScanJob): Promise<JobOutcome> {
  const log = ctx.log ?? (() => {});
  try {
    // Opnieuw controleren op het moment van scannen: bevestiging kan vervallen zijn.
    const d = await one<{ verified_at: Date | null; opted_out: boolean }>(
      ctx.pool,
      `SELECT d.verified_at, EXISTS (SELECT 1 FROM scan_opt_out o WHERE o.name = d.name) AS opted_out
         FROM domain d WHERE d.id = $1`,
      [job.domainId],
    );
    if (!d?.verified_at) throw new ExpectedScanError('Het domein is niet (meer) bevestigd als van deze klant. We scannen het niet.');
    if (d.opted_out || ctx.optOut?.has(job.domainName)) throw new ExpectedScanError('Voor dit domein is gevraagd het niet te scannen.');

    const run = ctx.scan ?? scanDomain;
    const report: ScanReport = await withTimeout(
      run(job.domainName, { net: ctx.net, maxLevel: job.maxLevel, optOut: ctx.optOut }),
      ctx.timeoutMinutes,
    );
    const result = await withTransaction(ctx.pool, (client) => storeScanReport(client, job, report));
    log(`Scan ${job.domainName} klaar: urgentie ${result.urgency}, ${result.nieuw} nieuw, ${result.opgelost} opgelost.`);
    if (result.eerste) await mailFirstScan(ctx, job, result);
    return { status: 'klaar', result };
  } catch (err) {
    if (err instanceof StaleScanError) {
      log(err.message);
      return { status: 'overgeslagen' };
    }
    const expected = err instanceof ExpectedScanError || err instanceof DomainNotFoundError || err instanceof OptOutError;
    const message = err instanceof Error ? err.message : String(err);
    await failScan(ctx, job, message);
    if (!expected) {
      await recordError(ctx.pool, {
        source: 'scanner',
        message: `Scan mislukt: ${message}`,
        organizationId: job.organizationId,
        context: { scanId: job.id, domein: job.domainName, poging: job.attempts + 1 },
      });
    }
    log(`Scan ${job.domainName} mislukt: ${message}`);
    return { status: 'mislukt', error: message };
  }
}

/** "Je eerste scan is klaar": het dashboard belooft deze mail. Een mislukte mail stopt de worker niet. */
async function mailFirstScan(ctx: WorkerContext, job: ScanJob, r: StoreResult): Promise<void> {
  if (!ctx.mailer) return;
  const to = await many<{ email: string }>(
    ctx.pool,
    `SELECT u.email FROM membership m JOIN app_user u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role IN ('eigenaar', 'beheerder') ORDER BY u.email LIMIT 10`,
    [job.organizationId],
  );
  const link = `${ctx.appOrigin ?? 'http://localhost:3000'}/o/${job.organizationId}/overzicht`;
  const wat =
    r.acties === 0
      ? 'We vonden niets dat je nu hoeft op te pakken.'
      : `We vonden ${r.acties === 1 ? 'één actie' : `${r.acties} acties`} om op te pakken. De belangrijkste staat bovenaan.`;
  for (const { email } of to) {
    try {
      await ctx.mailer.send({
        to: email,
        subject: `De eerste scan van ${job.domainName} is klaar`,
        text:
          `We hebben ${job.domainName} voor het eerst bekeken, zoals een gewone bezoeker dat doet. ${wat}\n\n` +
          `Bekijk het overzicht:\n${link}\n\n` +
          `Vanaf nu kijken we elke week opnieuw en laten we zien wat er veranderd is.`,
      });
    } catch {
      // LoggingMailer legt de fout al vast in de cockpit.
    }
  }
}

export async function heartbeat(pool: pg.Pool, workerId: string, delta: { klaar?: number; mislukt?: number } = {}): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeat AS h (worker_id, scans_klaar, scans_mislukt) VALUES ($1, $2, $3)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(),
       scans_klaar = h.scans_klaar + EXCLUDED.scans_klaar, scans_mislukt = h.scans_mislukt + EXCLUDED.scans_mislukt`,
    [workerId, delta.klaar ?? 0, delta.mislukt ?? 0],
  );
  // Oude workers (meer dan een week stil) opruimen.
  await pool.query("DELETE FROM worker_heartbeat WHERE last_seen < now() - interval '7 days'");
}

/** Werkt de wachtrij af tot hij leeg is (of tot `max` scans). */
export async function drainQueue(ctx: WorkerContext, max = Infinity): Promise<{ klaar: number; mislukt: number }> {
  const stats = { klaar: 0, mislukt: 0 };
  for (let i = 0; i < max; i++) {
    const job = await claimNextScan(ctx.pool, ctx.workerId);
    if (!job) break;
    const r = await runScanJob(ctx, job);
    if (r.status === 'klaar') stats.klaar++;
    if (r.status === 'mislukt') stats.mislukt++;
    await heartbeat(ctx.pool, ctx.workerId, { klaar: r.status === 'klaar' ? 1 : 0, mislukt: r.status === 'mislukt' ? 1 : 0 });
  }
  return stats;
}
