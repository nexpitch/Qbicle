import { BrevoMailer, ConsoleMailer, createPool, type Mailer } from '@qbicle/platform';
import { loadUsageConfig } from './config.ts';
import { LoggingMailer } from './health.ts';
import { runBewaker } from './monitor.ts';
import './builtin-kinds.ts';

/**
 * Eén ronde van de bewakingsagent:
 *   docker compose run --rm bewaker
 * In productie elke 5 minuten (cron of geplande taak).
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Zet DATABASE_URL.');
  process.exit(1);
}
const pool = createPool(url);
let inner: Mailer = new ConsoleMailer();
let provider: 'brevo' | 'console' = 'console';
if (process.env.BREVO_API_KEY) {
  inner = new BrevoMailer({
    apiKey: process.env.BREVO_API_KEY,
    from: { email: process.env.QBICLE_MAIL_FROM ?? '', name: process.env.QBICLE_MAIL_FROM_NAME ?? 'Qbicle' },
    ...(process.env.QBICLE_MAIL_REPLY_TO ? { replyTo: process.env.QBICLE_MAIL_REPLY_TO } : {}),
    sandbox: process.env.QBICLE_MAIL_SANDBOX === 'aan',
  });
  provider = 'brevo';
}
try {
  const { stats } = await runBewaker({ pool, config: loadUsageConfig(), mailer: new LoggingMailer(inner, pool, provider) });
  console.log('Bewaker klaar:', JSON.stringify(stats));
} finally {
  await pool.end();
}
