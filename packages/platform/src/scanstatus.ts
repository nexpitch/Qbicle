import type { Platform } from './context.ts';
import { many, one } from './db.ts';
import { notFound } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';

/**
 * Wat de klant over scans ziet: wanneer de laatste was, wanneer de volgende komt,
 * en tijdens een scan de voortgang per stap. De planner in packages/worker
 * gebruikt dezelfde regels (interval, opnieuw na een fout).
 */

/** Elke zoveel dagen opnieuw scannen bij een lopend abonnement ("wekelijkse controle"). */
export const SCAN_INTERVAL_DAYS = Number(process.env.QBICLE_SCAN_INTERVAL_DAGEN) > 0 ? Number(process.env.QBICLE_SCAN_INTERVAL_DAGEN) : 7;
/** Na een mislukte scan opnieuw na zoveel uur, hooguit zoveel keer achter elkaar. */
export const SCAN_RETRY_HOURS = 6;
export const SCAN_MAX_FAILURES = 3;
/** Na een scan mag de klant pas na zoveel minuten zelf weer een scan starten. */
export const SCAN_COOLDOWN_MINUTES = 5;

const ACTIVE_SUBSCRIPTION = "('proef', 'actief', 'achterstallig', 'opgezegd')";

/** De stappen die de klant tijdens het scannen ziet; sleutels zijn de groepen van de scanner-checks. */
export const SCAN_STEPS = [
  { key: 'domein', label: 'Domein en DNS', uitleg: 'DNSSEC en welke certificaatuitgevers je toestaat', bezig: 'We controleren je DNS-records' },
  { key: 'e-mail', label: 'E-mail', uitleg: 'SPF, DKIM en DMARC: kan iemand uit jullie naam mailen?', bezig: 'We controleren je mailbeveiliging (SPF, DKIM en DMARC)' },
  { key: 'certificaat', label: 'Certificaat', uitleg: 'Is de beveiligde verbinding geldig en up-to-date?', bezig: 'We controleren het certificaat van je website' },
  { key: 'website', label: 'Website en software', uitleg: 'Beveiligingsinstellingen, cookies en verouderde software', bezig: 'We controleren je website: software, beveiligingsinstellingen en cookies' },
] as const;

/** Eén uitgevoerde controle, zoals de klant hem tijdens en na de scan ziet. */
export interface ScanControle {
  /** Sleutel van de scanner-check, bijv. "mail.dmarc". */
  key: string;
  titel: string;
  groep: string;
  /** Waarop: het domein of de website (zonder https://). */
  asset: string;
  uitkomst: 'ok' | 'finding' | 'unknown' | 'error' | 'not_applicable';
  bevindingen: number;
}

/** "Dit hebben we gecontroleerd": alleen controles die echt zijn uitgevoerd tellen mee. */
export function controleSamenvatting(controles: ScanControle[]): { uitgevoerd: number; bevindingen: number; nietGelukt: number } {
  return {
    uitgevoerd: controles.filter((c) => c.uitkomst === 'ok' || c.uitkomst === 'finding').length,
    bevindingen: controles.reduce((n, c) => n + (c.uitkomst === 'finding' ? c.bevindingen : 0), 0),
    nietGelukt: controles.filter((c) => c.uitkomst === 'unknown' || c.uitkomst === 'error').length,
  };
}

export type StepStatus = 'wachten' | 'bezig' | 'klaar';

/** Zoals de worker het in scan.progress zet. */
export interface ScanProgress {
  stappen: Record<string, { totaal: number; klaar: number }>;
  opslaan?: boolean;
  /** Uitgevoerde controles in de volgorde waarin ze klaar waren (sinds 0023; oudere scans hebben dit niet). */
  controles?: ScanControle[];
}

export interface ScanView {
  id: string;
  domainId: string;
  domain: string;
  status: 'wachtrij' | 'bezig' | 'klaar' | 'mislukt';
  trigger: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  steps: { key: string; label: string; uitleg: string; bezig: string; status: StepStatus }[];
  /** Uitgevoerde controles, één voor één zoals de worker ze afrondde. */
  controles: ScanControle[];
  samenvatting: { uitgevoerd: number; bevindingen: number; nietGelukt: number } | null;
  /** 0..100: hoe ver de scan is. */
  pct: number;
  result: { urgency: number; band: string; openFindings: number } | null;
  workerActief: boolean;
  /** Alleen bij status 'wachtrij'. */
  wacht: WaitInfo | null;
  /** Mislukt, maar opnieuw proberen heeft zin (niet bij een niet-bevestigd of afgemeld domein). */
  retryable: boolean;
}

/** Zo lang mag een scan in de wachtrij staan voordat we zeggen dat de scanner niet draait. */
export const SCAN_START_SECONDS = 30;

/** De worker geeft elke 30 seconden een hartslag; 90 seconden stil = hij draait niet. */
async function workerActive(p: Platform): Promise<boolean> {
  const r = await one<{ actief: boolean }>(
    p.pool,
    "SELECT EXISTS (SELECT 1 FROM worker_heartbeat WHERE last_seen > now() - interval '90 seconds') AS actief",
  );
  return Boolean(r?.actief);
}

/** Wat de klant ziet zolang een scan in de wachtrij staat. */
export interface WaitInfo {
  /** true: de scan had al moeten beginnen; toon de melding "De scanner draait niet". */
  vast: boolean;
  tekst: string;
  /** Alleen buiten productie: wat je op je eigen computer doet om de scanner te starten. */
  hulp: string | null;
}

export function waitInfo(opts: { createdAt: Date; workerActief: boolean; anderBezig: boolean; now?: Date; production?: boolean }): WaitInfo {
  const now = opts.now ?? new Date();
  const age = (now.getTime() - new Date(opts.createdAt).getTime()) / 1000;
  const production = opts.production ?? process.env.NODE_ENV === 'production';
  if (opts.workerActief && opts.anderBezig) {
    return { vast: false, tekst: 'Qbicle scant eerst een ander domein. Jouw scan begint direct daarna.', hulp: null };
  }
  if (opts.workerActief && age < SCAN_START_SECONDS) {
    return { vast: false, tekst: 'De scan begint over een paar seconden.', hulp: null };
  }
  if (!opts.workerActief && age < SCAN_START_SECONDS) {
    return { vast: false, tekst: 'We wachten tot de scanner de scan oppakt.', hulp: null };
  }
  return {
    vast: true,
    tekst: production
      ? 'De scanner draait op dit moment niet. Wij zijn gewaarschuwd en je scan start vanzelf zodra hij weer draait. Je hoeft niets te doen.'
      : 'De scanner draait niet, dus je scan blijft in de wachtrij staan. Hij start vanzelf zodra de scanner weer draait.',
    hulp: production
      ? null
      : 'Start Qbicle opnieuw met: bash scripts/klantomgeving.sh. Of kijk in Docker Desktop of qbicle-worker draait (groen) en start hem. Wat hij doet zie je met: docker compose --profile web logs -f worker',
  };
}

export function stepsFor(status: ScanView['status'], progress: ScanProgress | null): { steps: ScanView['steps']; pct: number } {
  let done = 0;
  const steps = SCAN_STEPS.map((s) => {
    const st = progress?.stappen?.[s.key];
    let stepStatus: StepStatus;
    if (status === 'klaar') stepStatus = 'klaar';
    else if (status !== 'bezig' || !st) stepStatus = 'wachten';
    else stepStatus = st.totaal > 0 && st.klaar >= st.totaal ? 'klaar' : 'bezig';
    if (stepStatus === 'klaar') done++;
    return { key: s.key, label: s.label, uitleg: s.uitleg, bezig: s.bezig, status: stepStatus };
  });
  const pct = status === 'klaar' ? 100 : status === 'bezig' ? Math.min(95, Math.round(5 + (done / SCAN_STEPS.length) * 85 + (progress?.opslaan ? 5 : 0))) : 0;
  return { steps, pct };
}

export async function getScan(p: Platform, userId: string, organizationId: string, scanId: string): Promise<ScanView> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  if (!isUuid(scanId)) throw notFound('Deze scan');
  const s = await one<{
    id: string;
    domain_id: string;
    name: string;
    status: ScanView['status'];
    trigger: string;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    error: string | null;
    progress: ScanProgress | null;
    urgency: number | null;
    band: string | null;
    ander_bezig: boolean;
  }>(
    p.pool,
    `SELECT s.id, s.domain_id, d.name, s.status, s.trigger, s.created_at, s.started_at, s.finished_at, s.error, s.progress,
            ss.urgency, ss.band,
            EXISTS (SELECT 1 FROM scan b WHERE b.status = 'bezig' AND b.id <> s.id) AS ander_bezig
       FROM scan s JOIN domain d ON d.id = s.domain_id LEFT JOIN score_snapshot ss ON ss.scan_id = s.id
      WHERE s.id = $1 AND d.organization_id = $2`,
    [scanId, organizationId],
  );
  if (!s) throw notFound('Deze scan');
  let result: ScanView['result'] = null;
  if (s.status === 'klaar' && s.urgency !== null) {
    const open = await one<{ n: number }>(
      p.pool,
      `SELECT count(*)::int AS n FROM finding f JOIN asset a ON a.id = f.asset_id
        WHERE a.domain_id = $1 AND a.status = 'actief' AND f.resolved_at IS NULL AND f.accepted_at IS NULL`,
      [s.domain_id],
    );
    result = { urgency: s.urgency, band: s.band ?? '', openFindings: open?.n ?? 0 };
  }
  const { steps, pct } = stepsFor(s.status, s.progress);
  // Een mislukte scan kan een technische melding hebben; de klant krijgt alleen uitleg die over zijn domein gaat.
  const error =
    s.status !== 'mislukt'
      ? null
      : /bestaat niet|niet \(meer\) bevestigd|gevraagd het niet te scannen|DNS/.test(s.error ?? '')
        ? s.error
        : 'De scan is niet gelukt door een storing bij Qbicle. We kijken ernaar en proberen het later vanzelf opnieuw.';
  const workerActief = await workerActive(p);
  return {
    id: s.id,
    domainId: s.domain_id,
    domain: s.name,
    status: s.status,
    trigger: s.trigger,
    createdAt: s.created_at,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    error,
    steps,
    pct,
    // In de volgorde van de stappen, zoals de klant ze ook tijdens de scan zag.
    controles: [...(s.progress?.controles ?? [])].sort(
      (a, b) => SCAN_STEPS.findIndex((x) => x.key === a.groep) - SCAN_STEPS.findIndex((x) => x.key === b.groep),
    ),
    samenvatting: s.progress?.controles?.length ? controleSamenvatting(s.progress.controles) : null,
    result,
    workerActief,
    retryable: s.status === 'mislukt' && !/niet \(meer\) bevestigd|gevraagd het niet te scannen/.test(s.error ?? ''),
    wacht: s.status === 'wachtrij' ? waitInfo({ createdAt: s.created_at, workerActief, anderBezig: s.ander_bezig }) : null,
  };
}

export interface DomainScanInfo {
  last: { id: string; finishedAt: Date; urgency: number | null } | null;
  current: { id: string; status: 'wachtrij' | 'bezig'; createdAt: Date } | null;
  lastFailed: { id: string; at: Date } | null;
  /** Wanneer de volgende automatische scan komt (null = geen automatische scan gepland). */
  next: Date | null;
  /** Uitleg in gewone taal bij `next`. */
  nextText: string;
  /** Kan de klant nu zelf een scan starten (niet te snel na de vorige)? */
  canStartAt: Date | null;
}

/** Scaninformatie per bevestigd domein van een organisatie. */
export async function domainScanInfo(
  p: Platform,
  userId: string,
  organizationId: string,
  now = new Date(),
): Promise<{ workerActief: boolean; domains: Map<string, DomainScanInfo> }> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  const rows = await many<{
    id: string;
    verified: boolean;
    last_id: string | null;
    last_at: Date | null;
    last_urgency: number | null;
    cur_id: string | null;
    cur_status: 'wachtrij' | 'bezig' | null;
    cur_at: Date | null;
    latest_status: string | null;
    latest_id: string | null;
    latest_at: Date | null;
    failures: number;
    subscribed: boolean;
  }>(
    p.pool,
    `SELECT d.id, d.verified_at IS NOT NULL AS verified,
            l.id AS last_id, l.finished_at AS last_at, ss.urgency AS last_urgency,
            c.id AS cur_id, c.status AS cur_status, c.created_at AS cur_at,
            x.status AS latest_status, x.id AS latest_id, x.created_at AS latest_at,
            (SELECT count(*)::int FROM scan f WHERE f.domain_id = d.id AND f.status = 'mislukt'
               AND f.created_at > coalesce(l.finished_at, '-infinity')) AS failures,
            EXISTS (SELECT 1 FROM subscription sub WHERE sub.organization_id = d.organization_id
                     AND sub.status IN ${ACTIVE_SUBSCRIPTION}) AS subscribed
       FROM domain d
       LEFT JOIN LATERAL (SELECT id, finished_at FROM scan WHERE domain_id = d.id AND status = 'klaar'
                          ORDER BY finished_at DESC LIMIT 1) l ON true
       LEFT JOIN score_snapshot ss ON ss.scan_id = l.id
       LEFT JOIN LATERAL (SELECT id, status, created_at FROM scan WHERE domain_id = d.id AND status IN ('wachtrij', 'bezig')
                          ORDER BY created_at DESC LIMIT 1) c ON true
       LEFT JOIN LATERAL (SELECT id, status, created_at FROM scan WHERE domain_id = d.id
                          ORDER BY created_at DESC LIMIT 1) x ON true
      WHERE d.organization_id = $1`,
    [organizationId],
  );
  const workerActief = await workerActive(p);
  const domains = new Map<string, DomainScanInfo>();
  const MIN = 60_000;
  for (const r of rows) {
    let next: Date | null = null;
    let nextText: string;
    if (!r.verified) {
      nextText = 'We scannen dit domein zodra je hebt bevestigd dat het van jullie is.';
    } else if (r.cur_id) {
      nextText = r.cur_status === 'bezig' ? 'Qbicle scant dit domein nu.' : 'De scan staat klaar en begint zo.';
    } else if (r.latest_status === 'mislukt') {
      if (r.failures < SCAN_MAX_FAILURES) {
        next = new Date(r.latest_at!.getTime() + SCAN_RETRY_HOURS * 60 * MIN);
        nextText = 'De vorige scan lukte niet. We proberen het automatisch opnieuw.';
      } else {
        nextText = 'De scan lukte een paar keer niet. Start hem zelf opnieuw als het probleem is opgelost.';
      }
    } else if (!r.last_id) {
      next = new Date(now.getTime() + MIN);
      nextText = 'De eerste scan start binnen een minuut.';
    } else if (r.subscribed) {
      next = new Date(r.last_at!.getTime() + SCAN_INTERVAL_DAYS * 24 * 60 * MIN);
      if (next < now) next = new Date(now.getTime() + MIN);
      nextText = SCAN_INTERVAL_DAYS === 7 ? 'We scannen elke week automatisch opnieuw.' : `We scannen elke ${SCAN_INTERVAL_DAYS} dagen automatisch opnieuw.`;
    } else {
      nextText = 'Elke week automatisch opnieuw scannen hoort bij een abonnement. Je kunt wel zelf een scan starten.';
    }
    if (next && !workerActief) nextText += ' Op dit moment draait de scanner niet; de scan start zodra hij weer draait.';
    // Na een mislukte scan mag je meteen opnieuw proberen (de daglimiet blijft gelden).
    const lastStart = r.latest_at && r.latest_status !== 'mislukt' ? new Date(r.latest_at.getTime() + SCAN_COOLDOWN_MINUTES * MIN) : null;
    domains.set(r.id, {
      last: r.last_id ? { id: r.last_id, finishedAt: r.last_at!, urgency: r.last_urgency } : null,
      current: r.cur_id ? { id: r.cur_id, status: r.cur_status!, createdAt: r.cur_at! } : null,
      lastFailed: r.latest_status === 'mislukt' ? { id: r.latest_id!, at: r.latest_at! } : null,
      next,
      nextText,
      canStartAt: lastStart && lastStart > now ? lastStart : null,
    });
  }
  return { workerActief, domains };
}
