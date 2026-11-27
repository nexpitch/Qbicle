import { audit, type Actor } from './audit.ts';
import type { Platform } from './context.ts';
import { many, one, withTransaction } from './db.ts';
import { notFound, PlatformError } from './errors.ts';
import { authorize, isUuid } from './organizations.ts';
import { can } from './roles.ts';

/**
 * Register van bedrijfskritische systemen: software waar een organisatie op draait,
 * intern of bij een leverancier (ERP, CRM, boekhouding, webshop, ...). Per systeem
 * de zakelijke impact bij uitval of datalek, zodat een technische bevinding een
 * zakelijke wordt ("je webshop met klant- en betaalgegevens draait op een oude versie").
 *
 * MKB: tot 5 systemen. Business: onbeperkt. Zonder lopend abonnement geldt de MKB-grens.
 * De beoordeling hieronder is een waarneming op basis van wat de klant invult,
 * geen juridisch oordeel.
 */

type UserActor = Actor & { userId: string };

export const SYSTEEM_SOORTEN = ['erp', 'crm', 'boekhouding', 'webshop', 'kassa', 'planning', 'klantportaal', 'hr-salaris', 'maatwerk', 'overig'] as const;
export const SYSTEEM_HOSTING = ['saas', 'cloud', 'eigen-server', 'onbekend'] as const;
export const SYSTEEM_IMPACT = ['laag', 'merkbaar', 'stil'] as const;
export const SYSTEEM_GEGEVENS = ['medewerkers', 'klanten', 'betaalgegevens', 'bijzonder'] as const;
export const SYSTEEM_INLOGGEN = ['sso', 'mfa', 'wachtwoord', 'onbekend'] as const;
export const SYSTEEM_UPDATES = ['leverancier', 'wij', 'niemand', 'onbekend'] as const;
export const JA_NEE = ['ja', 'nee', 'onbekend'] as const;
export const SYSTEEM_DATALOCATIE = ['eu', 'buiten-eu', 'onbekend'] as const;
export const SYSTEEM_TERUGVAL = ['getest', 'niet-getest', 'geen', 'onbekend'] as const;

export const MKB_MAX_SYSTEMEN = 5;

export interface SysteemInvoer {
  naam: string;
  leverancier?: string | null | undefined;
  soort: (typeof SYSTEEM_SOORTEN)[number];
  hosting?: (typeof SYSTEEM_HOSTING)[number] | undefined;
  adres?: string | null | undefined;
  eigenaar?: string | null | undefined;
  impactUitval: (typeof SYSTEEM_IMPACT)[number];
  gegevens?: (typeof SYSTEEM_GEGEVENS)[number][] | undefined;
  inloggen?: (typeof SYSTEEM_INLOGGEN)[number] | undefined;
  updates?: (typeof SYSTEEM_UPDATES)[number] | undefined;
  verwerkersovereenkomst?: (typeof JA_NEE)[number] | undefined;
  datalocatie?: (typeof SYSTEEM_DATALOCATIE)[number] | undefined;
  terugval?: (typeof SYSTEEM_TERUGVAL)[number] | undefined;
  notities?: string | null | undefined;
}

export interface Systeem extends Required<Omit<SysteemInvoer, 'leverancier' | 'adres' | 'eigenaar' | 'notities'>> {
  id: string;
  organizationId: string;
  leverancier: string | null;
  adres: string | null;
  eigenaar: string | null;
  notities: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SysteemImpact = 'hoog' | 'middel' | 'laag';

export interface SysteemActie {
  urgentie: 'crit' | 'warn';
  tekst: string;
}

export interface SysteemBeoordeling {
  impact: SysteemImpact;
  /** Waarom deze impact, in gewone taal. */
  waarom: string;
  acties: SysteemActie[];
}

export interface SysteemRegister {
  systemen: (Systeem & { beoordeling: SysteemBeoordeling })[];
  /** null = onbeperkt. */
  limiet: number | null;
  magWijzigen: boolean;
}

interface Row {
  id: string;
  organization_id: string;
  naam: string;
  leverancier: string | null;
  soort: Systeem['soort'];
  hosting: Systeem['hosting'];
  adres: string | null;
  eigenaar: string | null;
  impact_uitval: Systeem['impactUitval'];
  gegevens: Systeem['gegevens'];
  inloggen: Systeem['inloggen'];
  updates: Systeem['updates'];
  verwerkersovereenkomst: Systeem['verwerkersovereenkomst'];
  datalocatie: Systeem['datalocatie'];
  terugval: Systeem['terugval'];
  notities: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'id, organization_id, naam, leverancier, soort, hosting, adres, eigenaar, impact_uitval, gegevens, inloggen, updates, verwerkersovereenkomst, datalocatie, terugval, notities, created_at, updated_at';

const toSysteem = (r: Row): Systeem => ({
  id: r.id,
  organizationId: r.organization_id,
  naam: r.naam,
  leverancier: r.leverancier,
  soort: r.soort,
  hosting: r.hosting,
  adres: r.adres,
  eigenaar: r.eigenaar,
  impactUitval: r.impact_uitval,
  gegevens: r.gegevens,
  inloggen: r.inloggen,
  updates: r.updates,
  verwerkersovereenkomst: r.verwerkersovereenkomst,
  datalocatie: r.datalocatie,
  terugval: r.terugval,
  notities: r.notities,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const PERSOONSGEGEVENS = new Set<string>(['medewerkers', 'klanten', 'betaalgegevens', 'bijzonder']);
const GEVOELIG = new Set<string>(['betaalgegevens', 'bijzonder']);

/** Zakelijke beoordeling van één systeem op basis van wat de klant invulde. Pure functie. */
export type BeoordeelInvoer = Pick<Systeem, 'naam' | 'hosting' | 'eigenaar' | 'impactUitval' | 'inloggen' | 'updates' | 'verwerkersovereenkomst' | 'datalocatie' | 'terugval'> & {
  gegevens: readonly Systeem['gegevens'][number][];
};

export function beoordeelSysteem(s: BeoordeelInvoer): SysteemBeoordeling {
  const persoons = s.gegevens.some((g) => PERSOONSGEGEVENS.has(g));
  const gevoelig = s.gegevens.some((g) => GEVOELIG.has(g));
  const klanten = s.gegevens.includes('klanten');

  let impact: SysteemImpact = 'laag';
  const redenen: string[] = [];
  if (s.impactUitval === 'stil') redenen.push('het bedrijf ligt stil als het uitvalt');
  if (gevoelig) redenen.push(s.gegevens.includes('betaalgegevens') ? 'er staan betaalgegevens in' : 'er staan bijzondere persoonsgegevens in');
  if (redenen.length) impact = 'hoog';
  else if (s.impactUitval === 'merkbaar' || klanten) {
    impact = 'middel';
    redenen.push(s.impactUitval === 'merkbaar' ? 'uitval is merkbaar voor klanten of medewerkers' : 'er staan klantgegevens in');
  } else {
    redenen.push(persoons ? 'beperkte gevolgen bij uitval, wel persoonsgegevens' : 'beperkte gevolgen bij uitval of lek');
  }

  const acties: SysteemActie[] = [];
  const hoog = impact === 'hoog';
  if ((klanten || gevoelig) && (s.inloggen === 'wachtwoord' || s.inloggen === 'onbekend')) {
    acties.push({
      urgentie: gevoelig ? 'crit' : 'warn',
      tekst: `Zet tweestapsverificatie (MFA) aan voor ${s.naam}, of log in via Microsoft of Google.`,
    });
  }
  if (s.impactUitval === 'stil' && s.terugval !== 'getest') {
    acties.push({
      urgentie: s.terugval === 'geen' ? 'crit' : 'warn',
      tekst:
        s.terugval === 'niet-getest'
          ? `Test de back-up of export van ${s.naam}: kun je echt verder als het uitvalt?`
          : `Leg vast hoe je doorwerkt als ${s.naam} uitvalt, en zorg voor een back-up of export.`,
    });
  }
  if (s.hosting === 'eigen-server' && (s.updates === 'niemand' || s.updates === 'onbekend')) {
    acties.push({ urgentie: hoog ? 'crit' : 'warn', tekst: `Spreek af wie de updates van ${s.naam} installeert, en hoe vaak.` });
  }
  if (persoons && s.verwerkersovereenkomst !== 'ja' && s.hosting !== 'eigen-server') {
    acties.push({ urgentie: 'warn', tekst: `Vraag de leverancier van ${s.naam} om een verwerkersovereenkomst (AVG).` });
  }
  if (persoons && s.datalocatie === 'buiten-eu') {
    acties.push({ urgentie: 'warn', tekst: `De gegevens in ${s.naam} staan buiten de EU. Controleer of de leverancier dat goed geregeld heeft.` });
  }
  if (!s.eigenaar) acties.push({ urgentie: 'warn', tekst: `Wijs iemand aan die verantwoordelijk is voor ${s.naam}.` });

  acties.sort((a, b) => (a.urgentie === b.urgentie ? 0 : a.urgentie === 'crit' ? -1 : 1));
  const waarom = redenen.join(' en ');
  return { impact, waarom: waarom.charAt(0).toUpperCase() + waarom.slice(1) + '.', acties };
}

async function huidigPakket(p: Platform, organizationId: string): Promise<string | null> {
  const r = await one<{ plan: string }>(
    p.pool,
    `SELECT plan FROM subscription WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd') LIMIT 1`,
    [organizationId],
  );
  return r?.plan ?? null;
}

export function systeemLimiet(plan: string | null): number | null {
  return plan === 'business' ? null : MKB_MAX_SYSTEMEN;
}

const leeg = (v: string | null | undefined) => {
  const t = v?.trim();
  return t ? t : null;
};

function schoon(input: SysteemInvoer) {
  const naam = input.naam?.trim();
  if (!naam) throw new PlatformError('ongeldige_invoer', 'Geef het systeem een naam.');
  return {
    naam,
    leverancier: leeg(input.leverancier),
    soort: input.soort,
    hosting: input.hosting ?? 'onbekend',
    adres: leeg(input.adres),
    eigenaar: leeg(input.eigenaar),
    impactUitval: input.impactUitval,
    gegevens: [...new Set(input.gegevens ?? [])],
    inloggen: input.inloggen ?? 'onbekend',
    updates: input.updates ?? 'onbekend',
    verwerkersovereenkomst: input.verwerkersovereenkomst ?? 'onbekend',
    datalocatie: input.datalocatie ?? 'onbekend',
    terugval: input.terugval ?? 'onbekend',
    notities: leeg(input.notities),
  };
}

const IMPACT_VOLGORDE: Record<SysteemImpact, number> = { hoog: 0, middel: 1, laag: 2 };

export async function listSystemen(p: Platform, userId: string, organizationId: string): Promise<SysteemRegister> {
  const access = await authorize(p.pool, userId, organizationId, 'org:lezen');
  const rows = await many<Row>(p.pool, `SELECT ${COLS} FROM systeem WHERE organization_id = $1 ORDER BY naam`, [organizationId]);
  const systemen = rows
    .map(toSysteem)
    .map((s) => ({ ...s, beoordeling: beoordeelSysteem(s) }))
    .sort((a, b) => IMPACT_VOLGORDE[a.beoordeling.impact] - IMPACT_VOLGORDE[b.beoordeling.impact] || a.naam.localeCompare(b.naam, 'nl'));
  return { systemen, limiet: systeemLimiet(await huidigPakket(p, organizationId)), magWijzigen: can(access, 'domeinen:beheren') };
}

export async function getSysteem(p: Platform, userId: string, organizationId: string, id: string): Promise<Systeem & { beoordeling: SysteemBeoordeling }> {
  await authorize(p.pool, userId, organizationId, 'org:lezen');
  if (!isUuid(id)) throw notFound('Dit systeem');
  const r = await one<Row>(p.pool, `SELECT ${COLS} FROM systeem WHERE organization_id = $1 AND id = $2`, [organizationId, id]);
  if (!r) throw notFound('Dit systeem');
  const s = toSysteem(r);
  return { ...s, beoordeling: beoordeelSysteem(s) };
}

export async function addSysteem(p: Platform, actor: UserActor, organizationId: string, input: SysteemInvoer): Promise<Systeem> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  const v = schoon(input);
  const limiet = systeemLimiet(await huidigPakket(p, organizationId));
  return withTransaction(p.pool, async (q) => {
    // Eén toevoeging tegelijk per organisatie, zodat de grens niet te omzeilen is met gelijktijdige aanvragen.
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`systeem:${organizationId}`]);
    if (limiet !== null) {
      const n = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM systeem WHERE organization_id = $1', [organizationId]);
      if ((n?.n ?? 0) >= limiet) {
        throw new PlatformError('geen_toegang', `Met Qbicle MKB kun je ${limiet} systemen vastleggen. Met Qbicle Business is dat onbeperkt.`);
      }
    }
    const r = await one<Row>(
      q,
      `INSERT INTO systeem (organization_id, naam, leverancier, soort, hosting, adres, eigenaar, impact_uitval, gegevens, inloggen,
                            updates, verwerkersovereenkomst, datalocatie, terugval, notities, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${COLS}`,
      [organizationId, v.naam, v.leverancier, v.soort, v.hosting, v.adres, v.eigenaar, v.impactUitval, v.gegevens, v.inloggen, v.updates, v.verwerkersovereenkomst, v.datalocatie, v.terugval, v.notities, actor.userId],
    );
    await audit(q, actor, { organizationId, action: 'systeem.toegevoegd', subject: r!.id, detail: { naam: v.naam } });
    return toSysteem(r!);
  });
}

export async function updateSysteem(p: Platform, actor: UserActor, organizationId: string, id: string, input: SysteemInvoer): Promise<Systeem> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  if (!isUuid(id)) throw notFound('Dit systeem');
  const v = schoon(input);
  const r = await one<Row>(
    p.pool,
    `UPDATE systeem SET naam = $3, leverancier = $4, soort = $5, hosting = $6, adres = $7, eigenaar = $8, impact_uitval = $9, gegevens = $10,
            inloggen = $11, updates = $12, verwerkersovereenkomst = $13, datalocatie = $14, terugval = $15, notities = $16, updated_at = now()
      WHERE organization_id = $1 AND id = $2 RETURNING ${COLS}`,
    [organizationId, id, v.naam, v.leverancier, v.soort, v.hosting, v.adres, v.eigenaar, v.impactUitval, v.gegevens, v.inloggen, v.updates, v.verwerkersovereenkomst, v.datalocatie, v.terugval, v.notities],
  );
  if (!r) throw notFound('Dit systeem');
  await audit(p.pool, actor, { organizationId, action: 'systeem.gewijzigd', subject: id, detail: { naam: v.naam } });
  return toSysteem(r);
}

export async function removeSysteem(p: Platform, actor: UserActor, organizationId: string, id: string): Promise<void> {
  await authorize(p.pool, actor.userId, organizationId, 'domeinen:beheren');
  if (!isUuid(id)) throw notFound('Dit systeem');
  const r = await one<{ naam: string }>(p.pool, 'DELETE FROM systeem WHERE organization_id = $1 AND id = $2 RETURNING naam', [organizationId, id]);
  if (!r) throw notFound('Dit systeem');
  await audit(p.pool, actor, { organizationId, action: 'systeem.verwijderd', subject: id, detail: { naam: r.naam } });
}
