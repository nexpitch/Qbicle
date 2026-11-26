/**
 * Rollen en rechten. Eén plek, pure functies, zodat de regels makkelijk te
 * toetsen en te reviewen zijn.
 *
 * - eigenaar:  alles, ook partners toelaten en eigenaren benoemen.
 * - beheerder: dagelijks beheer: domeinen, scans, collega's uitnodigen (tot beheerder).
 * - lezer:     alleen kijken.
 *
 * Een IT-partner krijgt bij een klant hooguit de rol uit partner_access
 * (beheerder of lezer), en nooit meer dan zijn eigen rol binnen de partner.
 * Via een partner kun je nooit andere partners toelaten of de organisatie opheffen.
 */
export const ROLES = ['eigenaar', 'beheerder', 'lezer'] as const;
export type Role = (typeof ROLES)[number];

export const PARTNER_ACCESS = ['beheerder', 'lezer'] as const;
export type PartnerAccessLevel = (typeof PARTNER_ACCESS)[number];

export const ORG_KINDS = ['klant', 'it-partner', 'adviseur'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

const RANK: Record<Role, number> = { lezer: 1, beheerder: 2, eigenaar: 3 };

export function rank(role: Role): number {
  return RANK[role];
}

export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}

export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

export const PERMISSIONS = [
  'org:lezen',
  'org:wijzigen',
  'leden:lezen',
  'leden:uitnodigen',
  'leden:beheren',
  'partners:beheren',
  'klanten:beheren',
  'domeinen:lezen',
  'domeinen:beheren',
  'scans:starten',
  'bevindingen:lezen',
  'bevindingen:accepteren',
  'delen:aanmaken',
  'audit:lezen',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const LEZER: Permission[] = ['org:lezen', 'leden:lezen', 'domeinen:lezen', 'bevindingen:lezen'];
const BEHEERDER: Permission[] = [
  ...LEZER,
  'org:wijzigen',
  'leden:uitnodigen',
  'leden:beheren',
  'klanten:beheren',
  'domeinen:beheren',
  'scans:starten',
  'bevindingen:accepteren',
  'delen:aanmaken',
  'audit:lezen',
];
const EIGENAAR: Permission[] = [...BEHEERDER, 'partners:beheren'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  lezer: new Set(LEZER),
  beheerder: new Set(BEHEERDER),
  eigenaar: new Set(EIGENAAR),
};

/** Rechten die je nooit via een IT-partner krijgt, ook niet als beheerder. */
const NEVER_VIA_PARTNER: ReadonlySet<Permission> = new Set<Permission>(['partners:beheren', 'klanten:beheren']);

export type AccessVia = 'lid' | 'partner';

export interface Access {
  organizationId: string;
  role: Role;
  via: AccessVia;
  /** Bij toegang via een partner: welke partnerorganisatie. */
  partnerOrgId?: string;
}

export function can(access: Pick<Access, 'role' | 'via'>, permission: Permission): boolean {
  if (access.via === 'partner' && NEVER_VIA_PARTNER.has(permission)) return false;
  return MATRIX[access.role].has(permission);
}

/** Rol van een partnermedewerker bij een klant. */
export function partnerRole(roleInPartnerOrg: Role, access: PartnerAccessLevel): Role {
  return minRole(roleInPartnerOrg, access);
}

/**
 * Mag iemand met `actor` een ander de rol `target` geven (bij uitnodigen of wijzigen)?
 * Je kunt nooit iemand een hogere rol geven dan je zelf hebt. Alleen een eigenaar
 * benoemt eigenaren, met één uitzondering: zolang een klant die door een
 * IT-partner is aangemaakt nog geen eigenaar heeft, mag de partner (als beheerder)
 * de eerste eigenaar uitnodigen.
 */
export function mayAssignRole(actor: Access, target: Role, orgHasOwner: boolean): boolean {
  if (actor.role === 'eigenaar') return true;
  if (target === 'eigenaar') {
    return actor.via === 'partner' && actor.role === 'beheerder' && !orgHasOwner;
  }
  return rank(target) <= rank(actor.role);
}
