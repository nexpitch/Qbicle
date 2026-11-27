import { audit, type Actor } from './audit.ts';
import { normalizeEmail } from './auth.ts';
import type { Platform } from './context.ts';
import { many, one } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize } from './organizations.ts';

/**
 * Contactpersonen van een organisatie: wie Qbicle bereikt bij een urgent lek,
 * een factuurvraag of iets technisch. Geen gebruikers: ze hoeven niet in te loggen.
 * Eén per soort. Beheerders en eigenaren wijzigen, iedereen met toegang ziet ze.
 */

export const CONTACT_KINDS = ['algemeen', 'financieel', 'technisch', 'security'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_LABELS: Record<ContactKind, { titel: string; uitleg: string }> = {
  algemeen: { titel: 'Algemeen contact', uitleg: 'Voor vragen over het account en het contract.' },
  financieel: { titel: 'Financieel contact', uitleg: 'Krijgt vragen over facturen en betalingen.' },
  technisch: { titel: 'Technisch contact', uitleg: 'Vaak je IT-partner. Voor vragen over koppelingen en scans.' },
  security: { titel: 'Contact bij een urgent lek', uitleg: 'Wie we direct bellen of mailen als er iets met spoed moet gebeuren.' },
};

export function isContactKind(x: unknown): x is ContactKind {
  return typeof x === 'string' && (CONTACT_KINDS as readonly string[]).includes(x);
}

export interface Contact {
  kind: ContactKind;
  name: string;
  email: string | null;
  phone: string | null;
  updatedAt: Date;
}

type UserActor = Actor & { userId: string };

export async function listContacts(p: Platform, userId: string, organizationId: string): Promise<Contact[]> {
  await authorize(p.pool, userId, organizationId, 'org:lezen');
  const rows = await many<{ kind: ContactKind; name: string; email: string | null; phone: string | null; updated_at: Date }>(
    p.pool,
    `SELECT kind, name, email::text, phone, updated_at FROM org_contact WHERE organization_id = $1
      ORDER BY array_position(ARRAY['algemeen','financieel','technisch','security'], kind)`,
    [organizationId],
  );
  return rows.map((r) => ({ kind: r.kind, name: r.name, email: r.email, phone: r.phone, updatedAt: r.updated_at }));
}

function cleanPhone(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  if (!/^\+?[0-9 ()-]{6,30}$/.test(t)) throw new PlatformError('ongeldige_invoer', 'Dit telefoonnummer klopt niet. Voorbeeld: 06 12345678 of +31 20 1234567.');
  return t.replace(/\s+/g, ' ');
}

export async function setContact(
  p: Platform,
  actor: UserActor,
  organizationId: string,
  kind: string,
  input: { naam?: string | null; email?: string | null; telefoon?: string | null },
): Promise<Contact> {
  if (!isContactKind(kind)) throw notFound('Deze soort contactpersoon');
  await authorize(p.pool, actor.userId, organizationId, 'org:wijzigen');
  const name = (input.naam ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new PlatformError('ongeldige_invoer', 'Vul een naam in.');
  if (name.length > 120) throw new PlatformError('ongeldige_invoer', 'De naam is te lang.');
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  const phone = cleanPhone(input.telefoon);
  if (!email && !phone) throw new PlatformError('ongeldige_invoer', 'Vul een e-mailadres of telefoonnummer in, zodat we deze persoon kunnen bereiken.');
  const r = await one<{ updated_at: Date }>(
    p.pool,
    `INSERT INTO org_contact (organization_id, kind, name, email, phone, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, kind) DO UPDATE
       SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING updated_at`,
    [organizationId, kind, name, email, phone, actor.userId],
  );
  await audit(p.pool, actor, { organizationId, action: 'contactpersoon.gewijzigd', subject: kind });
  return { kind, name, email, phone, updatedAt: r!.updated_at };
}

export async function removeContact(p: Platform, actor: UserActor, organizationId: string, kind: string): Promise<void> {
  if (!isContactKind(kind)) throw notFound('Deze soort contactpersoon');
  await authorize(p.pool, actor.userId, organizationId, 'org:wijzigen');
  const r = await p.pool.query('DELETE FROM org_contact WHERE organization_id = $1 AND kind = $2', [organizationId, kind]);
  if (!r.rowCount) throw notFound('Deze contactpersoon');
  await audit(p.pool, actor, { organizationId, action: 'contactpersoon.verwijderd', subject: kind });
}
