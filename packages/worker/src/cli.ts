import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { BrevoMailer, createPool, mailerFromEnv, type Mailer } from '@qbicle/platform';
import { LoggingMailer } from '@qbicle/ops';
import { createNodeNet, loadOptOut } from '@qbicle/scanner';
import { DEFAULT_PLANNER, planScans } from './planner.ts';
import { drainQueue, heartbeat, newWorkerId, type WorkerContext } from './worker.ts';

/**
 * Scan-worker met planner.
 *
 *   npm run worker                 blijft draaien: elke minuut plannen, elke paar seconden de wachtrij afwerken
 *   npm run worker -- --eenmalig   één ronde (plannen + wachtrij leeg) en stoppen
 *   docker compose run --rm worker --eenmalig
 *
 * Instellingen (omgeving): QBICLE_SCAN_INTERVAL_DAGEN (7), QBICLE_SCAN_TIMEOUT_MINUTEN (10),
 * QBICLE_WORKER_PAUZE_SECONDEN (60, plannen),
 * QBICLE_WORKER_WACHTRIJ_SECONDEN (3, hoe vaak de wachtrij bekeken wordt), QBICLE_DOH_URL, QBICLE_SCANNER_INFO_URL, QBICLE_OPTOUT_FILE.
 */
const { values } = parseArgs({ options: { eenmalig: { type: 'boolean', default: false } } });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Zet DATABASE_URL.');
  process.exit(1);
}
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const pool = createPool(url);
let mailer: Mailer | undefined;
try {
  const m = mailerFromEnv();
  mailer = new LoggingMailer(m, pool, m instanceof BrevoMailer ? 'brevo' : 'console');
} catch (err) {
  console.warn(`[worker] Geen mail na de eerste scan: ${err instanceof Error ? err.message : err}`);
}
const ctx: WorkerContext = {
  pool,
  net: createNodeNet({ dohUrl: process.env.QBICLE_DOH_URL || undefined, infoUrl: process.env.QBICLE_SCANNER_INFO_URL || undefined }),
  workerId: newWorkerId(),
  timeoutMinutes: num('QBICLE_SCAN_TIMEOUT_MINUTEN', 10),
  optOut: loadOptOut(process.env.QBICLE_OPTOUT_FILE || undefined),
  mailer,
  appOrigin: process.env.QBICLE_APP_ORIGIN || 'http://localhost:3000',
  log: (m) => console.log(`[worker] ${new Date().toISOString()} ${m}`),
};
const planner = { ...DEFAULT_PLANNER, intervalDays: num('QBICLE_SCAN_INTERVAL_DAGEN', DEFAULT_PLANNER.intervalDays) };
const pause = num('QBICLE_WORKER_PAUZE_SECONDEN', 60);
/** Een scan die de klant zelf start, moet binnen een paar seconden beginnen; niet pas bij de volgende planronde. */
const queuePoll = num('QBICLE_WORKER_WACHTRIJ_SECONDEN', 3);
/** Hartslag los van de rondes, zodat de klant ook tijdens een lange scan ziet dat de scanner draait. */
const HEARTBEAT_MS = 30_000;

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

async function plan(): Promise<void> {
  const planned = await planScans(pool, planner);
  for (const s of planned) ctx.log!(`Ingepland: ${s.domain} (${s.reason})`);
}

async function work(): Promise<void> {
  const stats = await drainQueue(ctx);
  if (stats.klaar || stats.mislukt) ctx.log!(`Wachtrij af: ${stats.klaar} gelukt, ${stats.mislukt} mislukt.`);
}

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[worker] ${what} mislukt:`, err);
    if (values.eenmalig) process.exitCode = 1;
  }
}

let beat: NodeJS.Timeout | undefined;
try {
  ctx.log!(
    `Gestart als ${ctx.workerId}${values.eenmalig ? ' (eenmalig)' : `: plant elke ${pause} seconden, kijkt elke ${queuePoll} seconden in de wachtrij`}.`,
  );
  await safely('Hartslag', () => heartbeat(pool, ctx.workerId));
  if (!values.eenmalig) beat = setInterval(() => void safely('Hartslag', () => heartbeat(pool, ctx.workerId)), HEARTBEAT_MS);
  let lastPlan = 0;
  do {
    if (Date.now() - lastPlan >= pause * 1000) {
      lastPlan = Date.now();
      await safely('Plannen', plan);
    }
    await safely('Wachtrij', work);
    if (values.eenmalig) break;
    for (let i = 0; i < queuePoll && !stopping; i++) await sleep(1000);
  } while (!stopping);
} finally {
  if (beat) clearInterval(beat);
  await pool.end();
}
