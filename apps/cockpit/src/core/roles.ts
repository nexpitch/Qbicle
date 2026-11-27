/**
 * Rollen van Qbicle-medewerkers in de cockpit. Los van de klantrollen
 * (eigenaar/beheerder/lezer binnen een klantorganisatie).
 *
 * - beheerder:  alles, ook medewerkers toevoegen en incasso's indienen.
 * - financieel: abonnementen, facturen en incasso's; klanten lezen.
 * - support:    klanten en gebruikers helpen (notities, status); facturen lezen.
 * - lezer:      alles bekijken, niets wijzigen.
 */
export const STAFF_ROLES = ['beheerder', 'financieel', 'support', 'lezer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = {
  beheerder: 'Beheerder',
  financieel: 'Financieel',
  support: 'Support',
  lezer: 'Lezer',
};

export const PERMISSIONS = {
  /** Cockpit openen en overzichten bekijken. */
  'cockpit.lezen': ['beheerder', 'financieel', 'support', 'lezer'],
  /** Klanten en gebruikers wijzigen (status, notities, blokkeren). */
  'klanten.beheren': ['beheerder', 'support'],
  /** Abonnementen, facturen en betaalwijze wijzigen. */
  'facturatie.beheren': ['beheerder', 'financieel'],
  /** Een gevalideerde incassobatch indienen bij de betaalprovider. */
  'incasso.indienen': ['beheerder', 'financieel'],
  /** Supporttickets afhandelen. */
  'support.beheren': ['beheerder', 'support'],
  /** Voorstellen van agents goedkeuren of afwijzen. */
  'agents.beheren': ['beheerder'],
  /** Medewerkers toevoegen, rol wijzigen, toegang intrekken. */
  'medewerkers.beheren': ['beheerder'],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

export function isStaffRole(v: unknown): v is StaffRole {
  return typeof v === 'string' && (STAFF_ROLES as readonly string[]).includes(v);
}
