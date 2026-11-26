import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { createApi } from './app.ts';
import { apiOptionsFromEnv, platformFromEnv } from './platform-from-env.ts';

/**
 * Start de API lokaal:  npm run api
 * Instellingen komen uit de omgeving of uit .env in de hoofdmap (niet gecommit).
 * Met BREVO_API_KEY gaat mail via Brevo, zonder sleutel naar de console.
 * (De web-app, npm run web, bevat deze API ook al onder /api/v1.)
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const platform = platformFromEnv();
const app = createApi(platform, apiOptionsFromEnv());

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  const mail = process.env.BREVO_API_KEY ? 'Brevo' + (process.env.QBICLE_MAIL_SANDBOX === 'aan' ? ' (sandbox)' : '') : 'console';
  console.log(`Qbicle API luistert op http://localhost:${info.port}/api/v1 (app: ${platform.config.appOrigin}, mail: ${mail}, betalen: ${platform.payments.name})`);
});
