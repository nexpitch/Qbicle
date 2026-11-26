import { createPool, DEFAULT_CONFIG, loadCatalog, mailerFromEnv, paymentProviderFromEnv, systemTxtResolver, type Platform } from '@qbicle/platform';

/**
 * Bouwt het platform uit de omgeving (of .env). Gedeeld door de losse API
 * (npm run api) en de web-app (npm run web), zodat beide hetzelfde doen.
 */
export function platformFromEnv(env = process.env): Platform {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Zet DATABASE_URL, zie .env.example');
    process.exit(1);
  }
  const appOrigin = env.QBICLE_APP_ORIGIN ?? DEFAULT_CONFIG.appOrigin;
  return {
    pool: createPool(databaseUrl),
    mailer: mailerFromEnv(),
    dns: systemTxtResolver(env.QBICLE_DNS_SERVERS?.split(',').filter(Boolean)),
    config: { ...DEFAULT_CONFIG, appOrigin },
    catalog: loadCatalog(),
    payments: paymentProviderFromEnv(appOrigin, env),
  };
}

export function apiOptionsFromEnv(env = process.env) {
  return {
    secureCookies: env.QBICLE_SECURE_COOKIES !== 'uit',
    trustProxy: env.QBICLE_TRUST_PROXY === 'aan',
  };
}
