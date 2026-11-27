import { createHash } from 'node:crypto';
import { many, one, type Mail, type Mailer, type Queryable } from '@qbicle/platform';
import type { OpsContext } from './context.ts';
import { recordUsage } from './metering.ts';

type Ctx = Pick<OpsContext, 'pool' | 'config'>;

// Scanjobs -------------------------------------------------------------------------

export interface ScanHealth {
  wachtrij: number;
  bezig: number;
  vast: number;
  klaar24u: number;
  mislukt24u: number;
  /** Minuten dat de oudste scan in de wachtrij staat (null = lege wachtrij). */
  oudsteWachtrijMinuten: number | null;
  gemiddeldeDuurSeconden24u: number | null;
  /** Percentage mislukt van alle afgeronde scans in de laatste 24 uur. */
  foutPercentage24u: number | null;
  /** Scan-workers met een hartslag in de laatste 5 minuten (tabel worker_heartbeat). */
  workersActief: number;
  /** Minuten sinds de laatste hartslag van een worker (null = nog nooit een worker gezien). */
  workerLaatstGezienMinuten: number | null;
}

export async function scanHealth(ctx: Ctx): Promise<ScanHealth> {
  const r = await one<Record<string, string | null>>(
    ctx.pool,
    `SELECT
       count(*) FILTER (WHERE status = 'wachtrij') AS wachtrij,
       count(*) FILTER (WHERE status = 'bezig' AND started_at >= now() - make_interval(mins => $1)) AS bezig,
       count(*) FILTER (WHERE status = 'bezig' AND (started_at IS NULL OR started_at < now() - make_interval(mins => $1))) AS vast,
       count(*) FILTER (WHERE status = 'klaar' AND finished_at > now() - interval '24 hours') AS klaar,
       count(*) FILTER (WHERE status = 'mislukt' AND coalesce(finished_at, created_at) > now() - interval '24 hours') AS mislukt,
       extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'wachtrij')) / 60 AS oudste,
       avg(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'klaar' AND finished_at > now() - interval '24 hours') AS duur
     FROM scan WHERE status IN ('wachtrij', 'bezig') OR coalesce(finished_at, created_at) > now() - interval '24 hours'`,
    [ctx.config.signalen.scanVastNaMinuten],
  );
  const klaar = Number(r?.klaar ?? 0);
  const mislukt = Number(r?.mislukt ?? 0);
  const w = await one<{ actief: string; laatst: string | null }>(
    ctx.pool,
    `SELECT count(*) FILTER (WHERE last_seen > now() - interval '5 minutes') AS actief,
            extract(epoch FROM now() - max(last_seen)) / 60 AS laatst
       FROM worker_heartbeat`,
  );
  return {
    wachtrij: Number(r?.wachtrij ?? 0),
    bezig: Number(r?.bezig ?? 0),
    vast: Number(r?.vast ?? 0),
    klaar24u: klaar,
    mislukt24u: mislukt,
    oudsteWachtrijMinuten: r?.oudste == null ? null : Math.round(Number(r.oudste)),
    gemiddeldeDuurSeconden24u: r?.duur == null ? null : Math.round(Number(r.duur)),
    foutPercentage24u: klaar + mislukt === 0 ? null : Math.round((mislukt / (klaar + mislukt)) * 100),
    workersActief: Number(w?.actief ?? 0),
    workerLaatstGezienMinuten: w?.laatst == null ? null : Math.round(Number(w.laatst)),
  };
}

export interface ScanJobRow {
  id: string;
  status: string;
  domain: string;
  organization_id: string;
  organization_name: string;
  trigger: string;
  attempts: number;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  /** true als de scan langer 'bezig' is dan scanVastNaMinuten. */
  stuck: boolean;
}

/** Scanjobs om naar te kijken: vast, mislukt of (te lang) in de wachtrij. */
export async function listScanJobs(
  ctx: Ctx,
  filter: 'vast' | 'mislukt' | 'wachtrij' | 'alle' = 'alle',
  opts: { organizationId?: string; limit?: number } = {},
): Promise<ScanJobRow[]> {
  const mins = ctx.config.signalen.scanVastNaMinuten;
  return many<ScanJobRow>(
    ctx.pool,
    `SELECT s.id, s.status, d.name AS domain, o.id AS organization_id, o.name AS organization_name, s.trigger,
            s.attempts, s.error, s.created_at, s.started_at, s.finished_at,
            (s.status = 'bezig' AND (s.started_at IS NULL OR s.started_at < now() - make_interval(mins => $1))) AS stuck
       FROM scan s JOIN domain d ON d.id = s.domain_id JOIN organization o ON o.id = d.organization_id
      WHERE ($2 = 'alle' OR ($2 = 'vast' AND s.status = 'bezig' AND (s.started_at IS NULL OR s.started_at < now() - make_interval(mins => $1)))
             OR ($2 = 'mislukt' AND s.status = 'mislukt') OR ($2 = 'wachtrij' AND s.status = 'wachtrij'))
        AND ($3::uuid IS NULL OR o.id = $3)
      ORDER BY s.created_at DESC LIMIT $4`,
    [mins, filter, opts.organizationId ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}

// Fouten ---------------------------------------------------------------------------

export type ErrorSource = 'scanner' | 'worker' | 'api' | 'web' | 'mail' | 'ai' | 'agent' | 'betaling' | 'cockpit';

/** Haalt wisselende delen (ids, getallen, adressen) uit een melding, zodat gelijke fouten samenvallen. */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<mail>')
    .replace(/\b\d+(\.\d+)*\b/g, '<n>')
    .trim()
    .slice(0, 300);
}

/**
 * Legt een fout vast. Dezelfde fout (bron + genormaliseerde melding, of een eigen
 * vingerafdruk) telt op; een opgeloste fout die terugkomt gaat weer open.
 * Mag nooit zelf een fout gooien die de aanroeper stoort.
 */
export async function recordError(
  q: Queryable,
  input: { source: ErrorSource; message: string; organizationId?: string | null; context?: Record<string, unknown>; fingerprint?: string },
): Promise<void> {
  const message = input.message.slice(0, 2000) || '(geen melding)';
  const fingerprint =
    input.fingerprint?.slice(0, 200) ??
    `${input.source}:${createHash('sha256').update(normalizeErrorMessage(message)).digest('hex').slice(0, 32)}`;
  try {
    await q.query(
      `INSERT INTO system_error AS e (fingerprint, source, message, organization_id, context)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fingerprint) DO UPDATE SET
         occurrences = e.occurrences + 1, last_seen = now(), message = EXCLUDED.message,
         organization_id = coalesce(EXCLUDED.organization_id, e.organization_id),
         context = coalesce(EXCLUDED.context, e.context), resolved_at = NULL, resolved_by = NULL`,
      [fingerprint, input.source, message, input.organizationId ?? null, input.context ? JSON.stringify(input.context) : null],
    );
  } catch (err) {
    console.error('Fout kon niet worden vastgelegd:', err);
  }
}

export interface ErrorRow {
  id: string;
  source: string;
  message: string;
  organization_id: string | null;
  organization_name: string | null;
  context: Record<string, unknown> | null;
  occurrences: number;
  first_seen: Date;
  last_seen: Date;
  resolved_at: Date | null;
}

export async function listErrors(
  q: Queryable,
  opts: { open?: boolean; source?: ErrorSource; organizationId?: string; limit?: number } = {},
): Promise<ErrorRow[]> {
  return many<ErrorRow>(
    q,
    `SELECT e.id, e.source, e.message, e.organization_id, o.name AS organization_name, e.context, e.occurrences,
            e.first_seen, e.last_seen, e.resolved_at
       FROM system_error e LEFT JOIN organization o ON o.id = e.organization_id
      WHERE (NOT $1::boolean OR e.resolved_at IS NULL)
        AND ($2::text IS NULL OR e.source = $2) AND ($3::uuid IS NULL OR e.organization_id = $3)
      ORDER BY e.last_seen DESC LIMIT $4`,
    [opts.open ?? true, opts.source ?? null, opts.organizationId ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}

export async function resolveError(q: Queryable, id: string, userId: string): Promise<boolean> {
  const r = await q.query('UPDATE system_error SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL', [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

// Mailbezorging -----------------------------------------------------------------------

export type MailProvider = 'brevo' | 'console' | 'geheugen';

/**
 * Zet om elke Mailer heen: legt elke verzonden mail vast (mail_event), telt
 * gebruik en registreert mislukte verzending als fout. De mail zelf gaat ongewijzigd door.
 */
export class LoggingMailer implements Mailer {
  constructor(
    private readonly inner: Mailer,
    private readonly pool: Queryable,
    private readonly provider: MailProvider,
  ) {}

  async send(mail: Mail): Promise<void> {
    try {
      await this.inner.send(mail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.log(mail, 'mislukt', msg);
      await recordError(this.pool, { source: 'mail', message: `Mail niet verstuurd: ${msg}`, context: { onderwerp: mail.subject } });
      throw err;
    }
    await this.log(mail, 'verstuurd', null);
  }

  private async log(mail: Mail, status: 'verstuurd' | 'mislukt', error: string | null): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO mail_event (recipient, subject, provider, status, error) VALUES ($1, $2, $3, $4, $5)',
        [mail.to.slice(0, 254), mail.subject.slice(0, 300), this.provider, status, error?.slice(0, 1000) ?? null],
      );
      if (status === 'verstuurd') {
        const org = await one<{ organization_id: string }>(
          this.pool,
          `SELECT m.organization_id FROM membership m JOIN app_user u ON u.id = m.user_id
            WHERE u.email = $1 ORDER BY m.created_at LIMIT 1`,
          [mail.to],
        );
        await recordUsage(this.pool, { organizationId: org?.organization_id ?? null, metric: 'mail', feature: 'transactioneel' });
      }
    } catch (err) {
      // Logging mag het versturen nooit breken.
      console.error('Mail kon niet worden gelogd:', err);
    }
  }
}

const BREVO_STATUS: Record<string, 'afgeleverd' | 'geopend' | 'uitgesteld' | 'gebounced' | 'geblokkeerd' | 'spam' | 'mislukt'> = {
  delivered: 'afgeleverd',
  opened: 'geopend',
  unique_opened: 'geopend',
  click: 'geopend',
  deferred: 'uitgesteld',
  soft_bounce: 'gebounced',
  hard_bounce: 'gebounced',
  blocked: 'geblokkeerd',
  spam: 'spam',
  invalid_email: 'mislukt',
  error: 'mislukt',
};

/**
 * Verwerkt een webhook-gebeurtenis van Brevo (transactioneel). Koppelt op
 * message-id, of anders op ontvanger + onderwerp van de laatste 3 dagen.
 * Geeft terug of er een mail is bijgewerkt.
 */
export async function applyBrevoEvent(
  q: Queryable,
  ev: { event?: string; email?: string; subject?: string; 'message-id'?: string; reason?: string },
): Promise<boolean> {
  const status = ev.event ? BREVO_STATUS[ev.event] : undefined;
  if (!status || !ev.email) return false;
  const msgId = ev['message-id']?.slice(0, 200) ?? null;
  const reason = ev.reason?.slice(0, 1000) ?? null;
  // Een latere 'geopend' mag een 'gebounced' niet overschrijven en omgekeerd niet terug naar 'afgeleverd'.
  const rank = `CASE status WHEN 'verstuurd' THEN 0 WHEN 'uitgesteld' THEN 1 WHEN 'afgeleverd' THEN 2 WHEN 'geopend' THEN 3 ELSE 4 END`;
  const newRank = { uitgesteld: 1, afgeleverd: 2, geopend: 3 }[status as string] ?? 4;
  const r = await q.query(
    `UPDATE mail_event SET status = $1, error = coalesce($2, error), updated_at = now(),
            provider_message_id = coalesce(provider_message_id, $3)
      WHERE id = (
        SELECT id FROM mail_event
         WHERE provider = 'brevo'
           AND (($3::text IS NOT NULL AND provider_message_id = $3)
                OR (provider_message_id IS NULL AND recipient = $4 AND ($5::text IS NULL OR subject = $5)
                    AND created_at > now() - interval '3 days'))
         ORDER BY (provider_message_id = $3) DESC NULLS LAST, created_at DESC LIMIT 1)
        AND ${rank} <= $6`,
    [status, reason, msgId, ev.email, ev.subject ?? null, newRank],
  );
  if ((r.rowCount ?? 0) > 0 && (status === 'gebounced' || status === 'geblokkeerd' || status === 'spam')) {
    await recordError(q, {
      source: 'mail',
      message: `Mail ${status}: ${reason ?? ev.event}`,
      fingerprint: `mail:${status}:${createHash('sha256').update(ev.email.toLowerCase()).digest('hex').slice(0, 24)}`,
      context: { onderwerp: ev.subject ?? null },
    });
  }
  return (r.rowCount ?? 0) > 0;
}

export interface MailHealth {
  totaal: number;
  perStatus: Record<string, number>;
  /** Percentage gebounced, geblokkeerd, spam of mislukt. */
  probleemPercentage: number | null;
}

export async function mailHealth(q: Queryable, days = 7): Promise<MailHealth> {
  const rows = await many<{ status: string; n: string }>(
    q,
    `SELECT status, count(*) AS n FROM mail_event WHERE created_at > now() - make_interval(days => $1) GROUP BY status`,
    [Math.min(Math.max(Math.trunc(days), 1), 90)],
  );
  const perStatus: Record<string, number> = {};
  let totaal = 0;
  let problemen = 0;
  for (const r of rows) {
    const n = Number(r.n);
    perStatus[r.status] = n;
    totaal += n;
    if (['gebounced', 'geblokkeerd', 'spam', 'mislukt'].includes(r.status)) problemen += n;
  }
  return { totaal, perStatus, probleemPercentage: totaal === 0 ? null : Math.round((problemen / totaal) * 1000) / 10 };
}

export interface MailRow {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function listMails(
  q: Queryable,
  opts: { recipient?: string; problemsOnly?: boolean; limit?: number } = {},
): Promise<MailRow[]> {
  return many<MailRow>(
    q,
    `SELECT id, recipient::text, subject, status, error, created_at, updated_at FROM mail_event
      WHERE ($1::citext IS NULL OR recipient = $1)
        AND (NOT $2::boolean OR status IN ('gebounced', 'geblokkeerd', 'spam', 'mislukt'))
      ORDER BY created_at DESC LIMIT $3`,
    [opts.recipient ?? null, opts.problemsOnly ?? false, Math.min(Math.max(opts.limit ?? 50, 1), 500)],
  );
}

// Overzicht -------------------------------------------------------------------------

export interface HealthSummary {
  scans: ScanHealth;
  mail: MailHealth;
  openFouten: number;
  aiFoutPercentage24u: number | null;
  /** 'goed' | 'aandacht' | 'storing', voor de kleur bovenaan de cockpit. */
  oordeel: 'goed' | 'aandacht' | 'storing';
  redenen: string[];
}

export async function healthSummary(ctx: Ctx): Promise<HealthSummary> {
  const scans = await scanHealth(ctx);
  const mail = await mailHealth(ctx.pool, 7);
  const fouten = await one<{ n: string }>(ctx.pool, 'SELECT count(*) AS n FROM system_error WHERE resolved_at IS NULL');
  const ai = await one<{ n: string; f: string }>(
    ctx.pool,
    `SELECT count(*) AS n, count(*) FILTER (WHERE outcome = 'fout') AS f FROM ai_call WHERE at > now() - interval '24 hours'`,
  );
  const aiN = Number(ai?.n ?? 0);
  const aiPct = aiN === 0 ? null : Math.round((Number(ai!.f) / aiN) * 100);
  const redenen: string[] = [];
  let level = 0;
  const raise = (l: number, why: string) => {
    level = Math.max(level, l);
    redenen.push(why);
  };
  if (scans.vast > 0) raise(1, `${scans.vast} scan(s) hangen`);
  if (scans.wachtrij > 0 && scans.workersActief === 0) {
    raise(2, scans.workerLaatstGezienMinuten === null
      ? 'Er staan scans klaar, maar er draait geen scan-worker'
      : `Er staan scans klaar, maar de scan-worker is ${scans.workerLaatstGezienMinuten} minuten stil`);
  } else if ((scans.oudsteWachtrijMinuten ?? 0) > ctx.config.signalen.scanWachtrijTeLangNaMinuten) {
    raise(2, `Oudste scan wacht al ${scans.oudsteWachtrijMinuten} minuten (draait de worker?)`);
  }
  if ((scans.foutPercentage24u ?? 0) >= 25 && scans.mislukt24u >= 3) raise(2, `${scans.foutPercentage24u}% van de scans mislukt`);
  else if (scans.mislukt24u > 0) raise(1, `${scans.mislukt24u} scan(s) mislukt in 24 uur`);
  if ((mail.probleemPercentage ?? 0) >= 5) raise(2, `${mail.probleemPercentage}% van de mail komt niet aan`);
  else if ((mail.probleemPercentage ?? 0) > 0) raise(1, 'Een deel van de mail komt niet aan');
  if ((aiPct ?? 0) >= 20 && aiN >= 5) raise(2, `${aiPct}% van de AI-aanroepen mislukt`);
  const openFouten = Number(fouten?.n ?? 0);
  if (openFouten > 0) raise(1, `${openFouten} open fout(en)`);
  return {
    scans,
    mail,
    openFouten,
    aiFoutPercentage24u: aiPct,
    oordeel: (['goed', 'aandacht', 'storing'] as const)[level]!,
    redenen,
  };
}
