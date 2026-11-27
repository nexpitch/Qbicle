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
    config: { ...DEFAULT_CONFIG, appOrigin, supplier: supplierFromEnv(env) },
    catalog: loadCatalog(),
    payments: paymentProviderFromEnv(appOrigin, env, pool),
    vies: viesFromEnv(env),
  };
}

/** Leveranciersgegevens op de factuur. Alleen wat Erik instelt; niets verzonnen. */
function supplierFromEnv(env: NodeJS.ProcessEnv) {
  const v = (k: string) => env[k]?.trim() || null;
  const d = DEFAULT_CONFIG.supplier;
  return {
    naam: v('QBICLE_LEVERANCIER_NAAM') ?? d.naam,
    handelsnaam: v('QBICLE_HANDELSNAAM') ?? d.handelsnaam,
    kvk: v('QBICLE_KVK_NUMMER') ?? d.kvk,
    btwNummer: v('QBICLE_BTW_NUMMER')?.replace(/[\s.]/g, '').toUpperCase() ?? d.btwNummer,
    adres: v('QBICLE_LEVERANCIER_ADRES') ?? d.adres,
    postcodePlaats: v('QBICLE_LEVERANCIER_POSTCODE_PLAATS') ?? d.postcodePlaats,
  };
}

export function apiOptionsFromEnv(env = process.env) {
  return {
    secureCookies: env.QBICLE_SECURE_COOKIES !== 'uit',
    trustProxy: env.QBICLE_TRUST_PROXY === 'aan',
  };
}
