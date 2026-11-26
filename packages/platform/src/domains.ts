import { DomainInputError, isSameOrSubdomain, normalizeDomain } from '@qbicle/scanner';
import { audit, SYSTEM_ACTOR, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { isUniqueViolation, many, one, withTransaction } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { hit, LIMITS } from './ratelimit.ts';
import { hashToken, looksLikeToken, newToken, newVerificationCode } from './tokens.ts';

/**
 * Domeinverificatie: een organisatie moet aantonen dat een domein van haar is
 * voordat Qbicle het vanuit het account scant en details toont.
 *
 * Methode 1, DNS-TXT (aanbevolen):  _qbicle-verificatie.<domein>  TXT  "qbicle-verificatie=<code>"
 *   (op het domein zelf mag ook). De code is per organisatie en domein uniek.
 *   Qbicle controleert het record later opnieuw; is het weg, dan vervalt de verificatie.
 * Methode 2, e-mail: een eenmalige link naar een vast beheeradres op het domein
 *   (admin@, administrator@, webmaster@, hostmaster@, postmaster@), zoals
 *   certificaatautoriteiten dat ook doen. Een willekeurig adres op het domein is
 *   bewust niet genoeg: elke medewerker heeft er een.
 *
 * Verificatie van voorbeeld.nl geldt ook voor subdomeinen (www.voorbeeld.nl).
 */

type UserActor = Actor & { userId: string };

export const TXT_LABEL = '_qbicle-verificatie';
export const TXT_PREFIX = 'qbicle-verificatie=';
export const ADMIN_MAILBOXES = ['admin', 'administrator', 'webmaster', 'hostmaster', 'postmaster'] as const;

export interface Domain {
  id: string;
  organizationId: string;
  name: string;
  verified: boolean;
  verifiedAt: Date | null;
  verificationMethod: 'dns-txt' | 'email' | null;
  createdAt: Date;
  instructions: VerificationInstructions;
}

export interface VerificationInstructions {
  dns: { type: 'TXT'; name: string; value: string; alternativeName: string };
  emailAddresses: string[];
}

interface DomainRow {
  id: string;
  organization_id: string;
  name: string;
  verified_at: Date | null;
  verification_method: 'dns-txt' | 'email' | null;
  verification_token: string;
  created_at: Date;
}

const COLS = 'id, organization_id, name, verified_at, verification_method, verification_token, created_at';

export function instructionsFor(name: string, code: string): VerificationInstructions {
  return {
    dns: { type: 'TXT', name: `${TXT_LABEL}.${name}`, value: `${TXT_PREFIX}${code}`, alternativeName: name },
    emailAddresses: ADMIN_MAILBOXES.map((m) => `${m}@${name}`),
  };
}

function toDomain(r: DomainRow): Domain {
  return {
    id: r.id,
    organizationId: r.organization_id,
    name: r.name,
    verified: r.verified_at !== null,
    verifiedAt: r.verified_at,
    verificationMethod: r.verification_method,
    createdAt: r.created_at,
    instructions: instructionsFor(r.name, r.verification_token),
  };
}

function parseDomain(input: string): string {
  try {
    return normalizeDomain(input);
  } catch (err) {
    if (err instanceof DomainInputError) throw new PlatformError('ongeldige_invoer', err.message);
    throw err;
  }
}

async function loadDomain(p: Platform, organizationId: string, domainId: string): Promise<DomainRow> {
  if (!isUuid(domainId)) throw notFound('Dit domein');
  const row = await one<DomainRow>(p.pool, `SELECT ${COLS} FROM domain WHERE id = $1 AND organization_id = $2`, [domainId, organizationId]);
  if (!row) throw notFound('Dit domein');
  return row;
}

export async function addDomain(p: Platform, actor: UserActor, organizationId: string, input: { name: string }): Promise<Domain> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const name = parseDomain(input.name);
  await hit(p.pool, LIMITS.domeinPerOrg, organizationId);
  try {
    const row = await one<DomainRow>(
      p.pool,
      `INSERT INTO domain (organization_id, name, verification_token, added_by) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [organizationId, name, newVerificationCode(), actor.userId],
    );
    await audit(p.pool, actor, { organizationId, action: 'domein.toegevoegd', subject: row!.id, detail: { domein: name } });
    return toDomain(row!);
  } catch (err) {
    if (isUniqueViolation(err)) throw new PlatformError('conflict', 'Dit domein staat al in je organisatie.');
    throw err;
  }
}

export async function listDomains(p: Platform, userId: string, organizationId: string): Promise<Domain[]> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  const rows = await many<DomainRow>(p.pool, `SELECT ${COLS} FROM domain WHERE organization_id = $1 ORDER BY name`, [organizationId]);
  return rows.map(toDomain);
}

export async function getDomain(p: Platform, userId: string, organizationId: string, domainId: string): Promise<Domain> {
  await authorize(p.pool, userId, organizationId, 'domeinen:lezen');
  return toDomain(await loadDomain(p, organizationId, domainId));
}

export async function removeDomain(p: Platform, actor: UserActor, organizationId: string, domainId: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const row = await loadDomain(p, organizationId, domainId);
  await p.pool.query('DELETE FROM domain WHERE id = $1', [row.id]);
  await audit(p.pool, actor, { organizationId, action: 'domein.verwijderd', subject: row.id, detail: { domein: row.name } });
}

/** Staat het juiste TXT-record er? Kijkt op _qbicle-verificatie.<domein> en op het domein zelf. */
export async function txtRecordPresent(p: Platform, name: string, code: string): Promise<boolean> {
  const expected = `${TXT_PREFIX}${code}`;
  for (const host of [`${TXT_LABEL}.${name}`, name]) {
    let records: string[];
    try {
      records = await p.dns.resolveTxt(host);
    } catch {
      continue; // DNS-fout telt als "niet gevonden", nooit als geslaagd
    }
    if (records.some((r) => r.trim() === expected)) return true;
  }
  return false;
}

export async function verifyDomainByDns(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  domainId: string,
): Promise<{ verified: boolean; domain: Domain; message: string }> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const row = await loadDomain(p, organizationId, domainId);
  await hit(p.pool, LIMITS.dnsCheckPerDomein, row.id);

  const found = await txtRecordPresent(p, row.name, row.verification_token);
  if (!found) {
    await audit(p.pool, actor, { organizationId, action: 'domein.verificatie_mislukt', subject: row.id, detail: { methode: 'dns-txt' } });
    return {
      verified: row.verified_at !== null,
      domain: toDomain(row),
      message:
        'Het TXT-record is (nog) niet gevonden. Een nieuw DNS-record kan tot een paar uur nodig hebben voordat het overal zichtbaar is.',
    };
  }
  const updated = await one<DomainRow>(
    p.pool,
    `UPDATE domain SET verified_at = COALESCE(verified_at, now()), verification_method = COALESCE(verification_method, 'dns-txt'),
            verified_by = COALESCE(verified_by, $2), verification_checked_at = now()
      WHERE id = $1 RETURNING ${COLS}`,
    [row.id, actor.userId],
  );
  if (!row.verified_at) {
    await audit(p.pool, actor, { organizationId, action: 'domein.geverifieerd', subject: row.id, detail: { methode: 'dns-txt', domein: row.name } });
  }
  return { verified: true, domain: toDomain(updated!), message: 'Het domein is geverifieerd.' };
}

export async function startEmailVerification(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  domainId: string,
  address: string,
): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const row = await loadDomain(p, organizationId, domainId);
  const allowed = instructionsFor(row.name, row.verification_token).emailAddresses;
  const chosen = address.trim().toLowerCase();
  if (!allowed.includes(chosen)) {
    throw new PlatformError('ongeldige_invoer', `Kies een van deze adressen: ${allowed.join(', ')}.`);
  }
  await hit(p.pool, LIMITS.verificatiemailPerDomein, row.id);
  const { token, hash } = newToken('domeinmail');
  await p.pool.query(
    `INSERT INTO domain_email_challenge (domain_id, address, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [row.id, chosen, hash, actor.userId, p.config.domainMailHours],
  );
  await audit(p.pool, actor, { organizationId, action: 'domein.verificatiemail_verstuurd', subject: row.id, detail: { adres: chosen } });
  await p.mailer.send({
    to: chosen,
    subject: `Bevestig dat ${row.name} bij jullie hoort`,
    text:
      `${actor.email ?? 'Iemand'} wil ${row.name} toevoegen aan Qbicle, zodat de beveiliging van dit domein bewaakt kan worden.\n\n` +
      `Klopt dat? Bevestig het via deze link (${p.config.domainMailHours} uur geldig):\n` +
      `${p.config.appOrigin}/domein-bevestigen#token=${token}\n\n` +
      `Ken je dit verzoek niet? Doe dan niets. Zonder bevestiging gebeurt er niets met het domein.`,
  });
}

/**
 * De link uit de verificatiemail. Hiervoor is geen account nodig: wie de
 * mailbox van het beheeradres leest, bevestigt namens het domein.
 */
export async function confirmEmailVerification(p: Platform, token: string, actor: Actor): Promise<{ domain: string }> {
  const invalid = new PlatformError('verlopen', 'Deze bevestigingslink is verlopen of al gebruikt.');
  if (!looksLikeToken('domeinmail', token)) throw invalid;
  return withTransaction(p.pool, async (q) => {
    const ch = await one<{ domain_id: string; address: string; created_by: string | null }>(
      q,
      `UPDATE domain_email_challenge SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING domain_id, address::text, created_by`,
      [hashToken(token)],
    );
    if (!ch) throw invalid;
    const d = await one<{ name: string; organization_id: string; verified_at: Date | null }>(
      q,
      `UPDATE domain SET verified_at = COALESCE(verified_at, now()), verification_method = COALESCE(verification_method, 'email'),
              verified_by = COALESCE(verified_by, $2), verification_checked_at = now()
        WHERE id = $1 RETURNING name, organization_id, verified_at`,
      [ch.domain_id, ch.created_by],
    );
    if (!d) throw invalid;
    await audit(q, actor, {
      organizationId: d.organization_id,
      action: 'domein.geverifieerd',
      subject: ch.domain_id,
      detail: { methode: 'email', adres: ch.address, domein: d.name },
    });
    return { domain: d.name };
  });
}

/**
 * Hercontrole door de worker (bijv. dagelijks). Een DNS-verificatie waarvan het
 * record al `dnsReverifyDays` niet meer gevonden is, vervalt. E-mailverificatie
 * vervalt na een jaar (moet dan opnieuw).
 */
export async function reverifyDomains(p: Platform): Promise<{ checked: number; lapsed: number }> {
  const rows = await many<DomainRow & { verification_checked_at: Date | null }>(
    p.pool,
    `SELECT ${COLS}, verification_checked_at FROM domain
      WHERE verified_at IS NOT NULL AND verification_method = 'dns-txt'
        AND (verification_checked_at IS NULL OR verification_checked_at < now() - interval '1 day')
      LIMIT 500`,
  );
  let lapsed = 0;
  for (const r of rows) {
    if (await txtRecordPresent(p, r.name, r.verification_token)) {
      await p.pool.query('UPDATE domain SET verification_checked_at = now() WHERE id = $1', [r.id]);
      continue;
    }
    const res = await p.pool.query(
      `UPDATE domain SET verified_at = NULL, verification_method = NULL, verified_by = NULL
        WHERE id = $1 AND COALESCE(verification_checked_at, verified_at) < now() - make_interval(days => $2)`,
      [r.id, p.config.dnsReverifyDays],
    );
    if (res.rowCount) {
      lapsed++;
      await audit(p.pool, SYSTEM_ACTOR, { organizationId: r.organization_id, action: 'domein.verificatie_vervallen', subject: r.id, detail: { domein: r.name } });
    }
  }
  const mail = await many<{ id: string; organization_id: string; name: string }>(
    p.pool,
    `UPDATE domain SET verified_at = NULL, verification_method = NULL, verified_by = NULL
      WHERE verification_method = 'email' AND verified_at < now() - interval '365 days'
      RETURNING id, organization_id, name`,
  );
  for (const m of mail) {
    lapsed++;
    await audit(p.pool, SYSTEM_ACTOR, { organizationId: m.organization_id, action: 'domein.verificatie_vervallen', subject: m.id, detail: { domein: m.name } });
  }
  return { checked: rows.length + mail.length, lapsed };
}

/** Is `host` (bijv. www.voorbeeld.nl) gedekt door een geverifieerd domein van deze organisatie? */
export async function isHostVerifiedFor(p: Platform, organizationId: string, host: string): Promise<boolean> {
  const rows = await many<{ name: string }>(
    p.pool,
    'SELECT name FROM domain WHERE organization_id = $1 AND verified_at IS NOT NULL',
    [organizationId],
  );
  return rows.some((r) => isSameOrSubdomain(host, r.name));
}
