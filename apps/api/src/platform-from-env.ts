import { BrevoMailer, createPool, DEFAULT_CONFIG, loadCatalog, mailerFromEnv, paymentProviderFromEnv, systemTxtResolver, viesFromEnv, type Platform } from '@qbicle/platform';
import { LoggingMailer } from '@qbicle/ops';

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
  const pool = createPool(databaseUrl);
  const mailer = mailerFromEnv();
  return {
    pool,
    // Elke mail komt in mail_event (bezorging zichtbaar in de cockpit).
    mailer: new LoggingMailer(mailer, pool, mailer instanceof BrevoMailer ? 'brevo' : 'console'),
    dns: systemTxtResolver(env.QBICLE_DNS_SERVERS?.split(',').filter(Boolean)),
    config: { ...DEFAULT_CONFIG, appOrigin, supplierVatNumber: env.QBICLE_BTW_NUMMER?.trim() || null },
    catalog: loadCatalog(),
    payments: paymentProviderFromEnv(appOrigin, env, pool),
    vies: viesFromEnv(env),
  };
}

export function apiOptionsFromEnv(env = process.env) {
  return {
    secureCookies: env.QBICLE_SECURE_COOKIES !== 'uit',
    trustProxy: env.QBICLE_TRUST_PROXY === 'aan',
  };
}
