import { serve } from '@hono/node-server';
import { ConsoleMailer, createPool, DEFAULT_CONFIG, systemTxtResolver, type Platform } from '@qbicle/platform';
import { createApi } from './app.ts';

/**
 * Start de API lokaal:  DATABASE_URL=... npm run api
 * Mail gaat voorlopig naar de console (er is nog geen maildienst gekozen).
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Zet DATABASE_URL, zie .env.example');
  process.exit(1);
}

const appOrigin = process.env.QBICLE_APP_ORIGIN ?? DEFAULT_CONFIG.appOrigin;
const platform: Platform = {
  pool: createPool(databaseUrl),
  mailer: new ConsoleMailer(),
  dns: systemTxtResolver(process.env.QBICLE_DNS_SERVERS?.split(',').filter(Boolean)),
  config: { ...DEFAULT_CONFIG, appOrigin },
};

const app = createApi(platform, {
  secureCookies: process.env.QBICLE_SECURE_COOKIES !== 'uit',
  trustProxy: process.env.QBICLE_TRUST_PROXY === 'aan',
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Qbicle API luistert op http://localhost:${info.port}/api/v1 (app: ${appOrigin})`);
});
