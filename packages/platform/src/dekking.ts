import type { AssetGroupKey, Dashboard } from './dashboard.ts';

/**
 * Eerlijke dekking per onderdeel van het overzicht (Erik, 27-11): "niet
 * gecontroleerd" is iets anders dan "geen problemen gevonden". Per soort assets
 * bepalen we wat we echt bekeken hebben:
 * - niet:     nog niets bekeken (geen scan, of het kan alleen via een koppeling);
 * - deels:    alleen van buiten (bijv. alleen de DNS van je mail, niet je
 *             Google Workspace-instellingen);
 * - volledig: de controles die bij dit onderdeel horen zijn gedaan.
 * Alleen bij "volledig" mag het overzicht "geen problemen gevonden" zeggen.
 */

export type Dekking = 'niet' | 'deels' | 'volledig';

export interface MailDienst {
  id: 'google-workspace' | 'microsoft365' | 'anders';
  naam: string;
}

export interface OnderdeelDekking {
  key: AssetGroupKey;
  dekking: Dekking;
  /** Wat we wél bekeken, in gewone taal. */
  gekeken: string;
  /** Wat we (nog) niet bekeken, of null als er niets ontbreekt. */
  nietGekeken: string | null;
  /** De ene knop die de dekking verbetert (koppelen, toevoegen), of null. */
  actie: { label: string; href: string } | null;
}

export interface DekkingOverzicht {
  onderdelen: OnderdeelDekking[];
  volledig: number;
  deels: number;
  niet: number;
  totaal: number;
  /** Minder dan de helft volledig gecontroleerd: geen geruststellende taal. */
  onvolledig: boolean;
  mailDienst: MailDienst | null;
}

const MAIL_DIENSTEN: { id: MailDienst['id']; naam: string; mx: RegExp }[] = [
  { id: 'google-workspace', naam: 'Google Workspace', mx: /(^|\.)(google|googlemail)\.com$/ },
  { id: 'microsoft365', naam: 'Microsoft 365', mx: /(^|\.)(outlook\.com|protection\.outlook\.com|office365\.us)$/ },
];

/** Herken de maildienst aan de mailservers (MX). */
export function mailDienstVoor(mxHosts: string[]): MailDienst | null {
  if (!mxHosts.length) return null;
  for (const d of MAIL_DIENSTEN) {
    if (mxHosts.some((h) => d.mx.test(h.toLowerCase().replace(/\.$/, '')))) return { id: d.id, naam: d.naam };
  }
  return { id: 'anders', naam: 'een andere maildienst' };
}

const CLOUD_KOPPELINGEN = ['microsoft365', 'google-workspace', 'aws', 'azure', 'google-cloud'];
const NETWERK_KOPPELINGEN = ['unifi', 'meraki', 'connector'];

/**
 * @param d          het dashboard (assets per soort, laatste scan)
 * @param gekoppeld  ids van actieve koppelingen (bijv. "microsoft365", "unifi")
 */
export function dekkingVoor(d: Pick<Dashboard, 'groups' | 'assets' | 'lastScanAt'>, gekoppeld: string[], base: string): DekkingOverzicht {
  const scanned = Boolean(d.lastScanAt);
  const has = (ids: string[]) => ids.some((id) => gekoppeld.includes(id));
  const count = (k: AssetGroupKey) => d.groups.find((g) => g.key === k)?.count ?? 0;
  const mailDienst = mailDienstVoor(d.assets.filter((a) => a.type === 'mailserver').map((a) => a.label));
  const k = (id: string) => `${base}/koppelingen/${id}`;
  const nogNiet = 'Nog niet gescand. De eerste scan start zodra je domein is bevestigd.';

  const onderdelen: OnderdeelDekking[] = d.groups.map((g): OnderdeelDekking => {
    switch (g.key) {
      case 'domeinen':
        return scanned
          ? { key: g.key, dekking: 'volledig', gekeken: 'Domeinnaam, DNS-instellingen en subdomeinen, van buiten bekeken.', nietGekeken: null, actie: null }
          : { key: g.key, dekking: 'niet', gekeken: nogNiet, nietGekeken: null, actie: { label: 'Domein toevoegen', href: `${base}/domeinen` } };
      case 'websites':
        return scanned
          ? {
              key: g.key,
              dekking: 'volledig',
              gekeken: count('websites') ? 'Certificaten, beveiligde verbinding, software en beveiligingsinstellingen.' : 'We vonden geen websites op je domein.',
              nietGekeken: null,
              actie: null,
            }
          : { key: g.key, dekking: 'niet', gekeken: nogNiet, nietGekeken: null, actie: null };
      case 'mail': {
        if (!scanned) return { key: g.key, dekking: 'niet', gekeken: nogNiet, nietGekeken: null, actie: null };
        if (!count('mail')) {
          return { key: g.key, dekking: 'deels', gekeken: 'We vonden geen mailservers bij je domein.', nietGekeken: 'Gebruik je wel mail op dit domein? Controleer dan de MX-instelling.', actie: null };
        }
        const dienst = mailDienst!;
        const koppelbaar = dienst.id !== 'anders';
        if (koppelbaar && has([dienst.id])) {
          return { key: g.key, dekking: 'volledig', gekeken: `DNS-instellingen van je mail en de instellingen in ${dienst.naam} via de koppeling.`, nietGekeken: null, actie: null };
        }
        return {
          key: g.key,
          dekking: 'deels',
          gekeken: 'Alleen de DNS-instellingen van je mail: MX, SPF, DKIM en DMARC.',
          nietGekeken: koppelbaar
            ? `Niet de instellingen in ${dienst.naam} zelf, zoals tweestapsverificatie, beheerders en automatisch doorsturen.`
            : 'Niet de instellingen van je maildienst zelf, zoals tweestapsverificatie en beheerders.',
          actie: koppelbaar ? { label: `Koppel ${dienst.naam}`, href: k(dienst.id) } : null,
        };
      }
      case 'servers':
        return count('servers')
          ? {
              key: g.key,
              dekking: 'deels',
              gekeken: 'Van buiten: welke poorten open staan en welke software erop draait.',
              nietGekeken: 'Niet de instellingen en updates op de server zelf, en geen servers die niet aan je domein hangen.',
              actie: { label: 'Server toevoegen', href: k('connector') },
            }
          : {
              key: g.key,
              dekking: 'niet',
              gekeken: scanned ? 'We zagen geen servers op je domein. Servers met alleen een IP-adres of achter een VPN vinden we zo niet.' : nogNiet,
              nietGekeken: 'Heb je een eigen server, vaste IP-adressen of een VPN? Voeg ze toe, dan controleren we ze.',
              actie: { label: 'Server toevoegen', href: k('connector') },
            };
      case 'cloud':
        if (has(CLOUD_KOPPELINGEN)) return { key: g.key, dekking: 'volledig', gekeken: 'Instellingen van je clouddiensten via de koppeling.', nietGekeken: null, actie: null };
        return {
          key: g.key,
          dekking: count('cloud') ? 'deels' : 'niet',
          gekeken: count('cloud') ? 'Wat van buiten zichtbaar is van je clouddiensten.' : 'Nog niets: clouddiensten zien we pas goed met een koppeling.',
          nietGekeken: 'Niet wie beheerder is, of tweestapsverificatie aan staat en of opslag openbaar is.',
          actie:
            mailDienst && mailDienst.id !== 'anders'
              ? { label: `Koppel ${mailDienst.naam}`, href: k(mailDienst.id) }
              : { label: 'Cloud koppelen', href: `${base}/koppelingen` },
        };
      case 'netwerk':
      case 'apparaten': {
        const wat = g.key === 'netwerk' ? 'routers, firewalls en wifi' : 'laptops, printers, camera’s en andere apparaten';
        if (has(NETWERK_KOPPELINGEN)) return { key: g.key, dekking: 'volledig', gekeken: `Je ${wat} via de koppeling met je netwerk.`, nietGekeken: null, actie: null };
        return {
          key: g.key,
          dekking: count(g.key) ? 'deels' : 'niet',
          gekeken: count(g.key) ? `Een deel van je ${wat}, zonder vaste koppeling.` : `Nog niets: je ${wat} zien we via een koppeling met je router.`,
          nietGekeken: count(g.key) ? 'Zonder koppeling missen we apparaten en updates.' : null,
          actie: { label: 'Router koppelen', href: `${base}/koppelingen` },
        };
      }
    }
  });

  const volledig = onderdelen.filter((o) => o.dekking === 'volledig').length;
  const deels = onderdelen.filter((o) => o.dekking === 'deels').length;
  return {
    onderdelen,
    volledig,
    deels,
    niet: onderdelen.length - volledig - deels,
    totaal: onderdelen.length,
    onvolledig: volledig * 2 < onderdelen.length,
    mailDienst,
  };
}
