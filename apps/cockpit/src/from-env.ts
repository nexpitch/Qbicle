import { keyRingFromEnv, SecretBox } from '@qbicle/devices';
import { platformFromEnv } from '@qbicle/api/src/platform-from-env.ts';
import { createHash } from 'node:crypto';
import { DEFAULT_COCKPIT_CONFIG, type Cockpit } from './core/staff.ts';

/**
 * Bouwt de cockpit uit de omgeving (of .env). Gedeeld door de server en de
 * beheer-CLI.
 */
export function cockpitFromEnv(env = process.env): { cockpit: Cockpit; secureCookies: boolean; trustProxy: boolean } {
  const secureCookies = env.QBICLE_SECURE_COOKIES !== 'uit';
  const origin = env.QBICLE_COCKPIT_ORIGIN ?? DEFAULT_COCKPIT_CONFIG.origin;
  return {
    cockpit: {
      p: platformFromEnv(env),
      config: { ...DEFAULT_COCKPIT_CONFIG, origin },
      box: new SecretBox(keyRing(env, secureCookies)),
    },
    secureCookies,
    trustProxy: env.QBICLE_TRUST_PROXY === 'aan',
  };
}

function keyRing(env: NodeJS.ProcessEnv, secureCookies: boolean) {
  if (env.QBICLE_SECRETS_KEYS) return keyRingFromEnv(env.QBICLE_SECRETS_KEYS);
  if (env.NODE_ENV === 'production' && secureCookies) {
    console.error('Zet QBICLE_SECRETS_KEYS (zie .env.example): nodig om MFA-geheimen versleuteld op te slaan.');
    process.exit(1);
  }
  // Alleen lokaal: vaste ontwikkelsleutel, zodat MFA blijft werken na een herstart.
  console.warn('Let op: QBICLE_SECRETS_KEYS ontbreekt; de cockpit gebruikt een lokale ontwikkelsleutel. Niet in productie gebruiken.');
  const key = createHash('sha256').update('qbicle-cockpit-lokaal-ontwikkelen').digest();
  return { currentId: 'lokaal', keys: new Map([['lokaal', key]]) };
}
