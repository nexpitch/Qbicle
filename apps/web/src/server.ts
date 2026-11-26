import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { apiOptionsFromEnv, platformFromEnv } from '@qbicle/api/src/platform-from-env.ts';
import { createWeb } from './app.tsx';

/**
 * Start de klantomgeving lokaal:  npm run web   (of: docker compose --profile web up web)
 * Open daarna http://localhost:3000. De API draait mee onder /api/v1.
 * Zonder BREVO_API_KEY staan inloglinks in de console; betalen gaat met testbetalingen.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const platform = platformFromEnv();
const app = createWeb(platform, apiOptionsFromEnv());

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Qbicle web-app op http://localhost:${info.port} (betalen: ${platform.payments.name === 'nep' ? 'testbetalingen' : platform.payments.name})`);
});
