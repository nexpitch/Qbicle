import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { createPool, DEFAULT_CONFIG, mailerFromEnv, systemTxtResolver, type Platform } from '@qbicle/platform';
import { createApi } from './app.ts';

/**
 * Start de API lokaal:  npm run api
 * Instellingen komen uit de omgeving of uit .env in de hoofdmap (niet gecommit).
 * Met BREVO_API_KEY gaat mail via Brevo, zonder sleutel naar de console.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Zet DATABASE_URL, zie .env.example');
  process.exit(1);
}

const appOrigin = process.env.QBICLE_APP_ORIGIN ?? DEFAULT_CONFIG.appOrigin;
const platform: Platform = {
  pool: createPool(databaseUrl),
  mailer: mailerFromEnv(),
  dns: systemTxtResolver(process.env.QBICLE_DNS_SERVERS?.split(',').filter(Boolean)),
  config: { ...DEFAULT_CONFIG, appOrigin },
};

const app = createApi(platform, {
  secureCookies: process.env.QBICLE_SECURE_COOKIES !== 'uit',
  trustProxy: process.env.QBICLE_TRUST_PROXY === 'aan',
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  const mail = process.env.BREVO_API_KEY ? 'Brevo' + (process.env.QBICLE_MAIL_SANDBOX === 'aan' ? ' (sandbox)' : '') : 'console';
  console.log(`Qbicle API luistert op http://localhost:${info.port}/api/v1 (app: ${appOrigin}, mail: ${mail})`);
});
