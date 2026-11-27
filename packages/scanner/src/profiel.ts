import type { VulnDb } from '@qbicle/devices';
import { profielOnderdeel, type ProfielOnderdeel } from './checks/software.ts';
import { eolSnapshot } from './kennis/eol.ts';
import { sharedVulnDb } from './kennis/index.ts';
import type { HttpResponse } from './net.ts';
import { beoordeel, detectAll, vulnsFor } from './software.ts';
import type { HostingInfo } from './hosting.ts';
import type { CheckResult } from './types.ts';

export type { HostingInfo } from './hosting.ts';

export type { ProfielOnderdeel } from './checks/software.ts';

/** Een beveiligingsmaatregel op de website: aan (true), uit (false) of niet vastgesteld (null). */
export interface Maatregel {
  key: string;
  label: string;
  ok: boolean | null;
  uitleg: string;
}

/**
 * Software- en serverprofiel van één website: wat draait er, krijgt het updates, en
 * welke standaard beveiligingsmaatregelen staan aan. Bouwt alleen op wat de checks al
 * zagen; doet zelf niets op het netwerk.
 */
export interface WebProfiel {
  versie: 1;
  website: string;
  /** Stand van de kennis over updates (endoflife.date-snapshot), of null. */
  kennisStand: string | null;
  onderdelen: ProfielOnderdeel[];
  maatregelen: Maatregel[];
  /** Versleuteling zoals de server die met ons afsprak, bijvoorbeeld "TLSv1.3". */
  tls: string | null;
  /** Zit er een beschermlaag (CDN) voor de server? Dan zien we de server zelf minder goed. */
  achterCdn: boolean;
  /** Waar de website draait (platform, hostingpartij, cloud), als we dat herkennen. */
  hosting?: HostingInfo | null;
}

/** Teksten per maatregel (ook voor voorbeelddata). */
export const MAATREGEL_TEKST: Record<string, { label: string; uitleg: string }> = {
  https: { label: 'Bezoekers gaan automatisch naar https', uitleg: 'Wie het adres zonder https intypt, komt toch op de beveiligde website.' },
  versies: { label: 'Softwareversies niet zichtbaar voor buitenstaanders', uitleg: 'Aanvallers zoeken gericht naar websites met een bekende, kwetsbare versie.' },
  cookies: { label: 'Cookies beveiligd', uitleg: 'Cookies gaan alleen over een beveiligde verbinding en zijn niet door scripts te stelen.' },
  securitytxt: { label: 'Meldpunt voor beveiligingsproblemen (security.txt)', uitleg: 'Wie een lek vindt, weet waar het gemeld kan worden.' },
  tls: { label: 'Moderne versleuteling', uitleg: 'TLS 1.2 en 1.3 zijn veilig; oudere versies niet. We zien de versie die de server met ons afsprak, niet of oudere versies ook nog aan staan.' },
};

export const HEADER_MAATREGELEN: { key: string; label: string; bad: string[]; uitleg: string }[] = [
  { key: 'hsts', label: 'Altijd een beveiligde verbinding (HSTS)', bad: ['web.hsts_missing', 'web.hsts_short'], uitleg: 'Browsers gebruiken alleen nog https, ook als iemand http intypt.' },
  { key: 'csp', label: 'Bescherming tegen ingevoegde scripts (CSP)', bad: ['web.csp_missing'], uitleg: 'Beperkt welke scripts de pagina mag laden; dat maakt misbruik via een lek veel lastiger.' },
  { key: 'framing', label: 'Niet in een andere website in te bouwen', bad: ['web.framing_unprotected', 'web.framing_login'], uitleg: 'Voorkomt dat een nepwebsite jouw pagina onzichtbaar inbouwt om klikken te stelen.' },
  { key: 'xcto', label: 'Bestandstypes niet laten raden (nosniff)', bad: ['web.xcto_missing'], uitleg: 'De browser voert geen bestanden uit die zich als iets anders voordoen.' },
  { key: 'referrer', label: 'Adressen niet doorgeven aan andere websites', bad: ['web.referrer_unsafe'], uitleg: 'Andere websites zien niet welke pagina je bezoeker net bekeek.' },
];

function findingKeys(c: CheckResult | undefined): Set<string> {
  return new Set((c?.findings ?? []).map((f) => f.key));
}

const ran = (c: CheckResult | undefined) => c?.outcome === 'ok' || c?.outcome === 'finding';

/** Eén profiel per website in het rapport. */
export function buildWebProfiles(checks: CheckResult[]): WebProfiel[] {
  const sites = [...new Set(checks.filter((c) => c.asset.type === 'website').map((c) => c.asset.value))];
  const out: WebProfiel[] = [];
  for (const site of sites) {
    const of = (key: string) => checks.find((c) => c.asset.value === site && c.checkKey === key);
    const sw = of('web.software');
    const onderdelen = (sw?.evidence.profiel as ProfielOnderdeel[] | undefined) ?? [];
    const maatregelen: Maatregel[] = [];

    const redirect = of('web.https_redirect');
    maatregelen.push({ key: 'https', ...MAATREGEL_TEKST.https!, ok: ran(redirect) ? !findingKeys(redirect).has('web.no_https_redirect') : null });

    const headers = of('web.headers');
    for (const m of HEADER_MAATREGELEN) {
      maatregelen.push({ key: m.key, label: m.label, ok: ran(headers) ? !m.bad.some((k) => findingKeys(headers).has(k)) : null, uitleg: m.uitleg });
    }

    const versions = of('web.version_disclosure');
    maatregelen.push({ key: 'versies', ...MAATREGEL_TEKST.versies!, ok: ran(versions) ? !findingKeys(versions).has('web.version_disclosed') : null });

    const cookies = of('web.cookies');
    if (cookies && cookies.outcome !== 'not_applicable') {
      maatregelen.push({ key: 'cookies', ...MAATREGEL_TEKST.cookies!, ok: ran(cookies) ? findingKeys(cookies).size === 0 : null });
    }

    const sec = of('web.security_txt');
    maatregelen.push({ key: 'securitytxt', ...MAATREGEL_TEKST.securitytxt!, ok: ran(sec) ? findingKeys(sec).size === 0 : null });

    const tlsCheck = of('tls.certificate');
    const protocol = typeof tlsCheck?.evidence.protocol === 'string' ? tlsCheck.evidence.protocol : null;
    if (protocol) {
      maatregelen.push({
        key: 'tls',
        label: `${MAATREGEL_TEKST.tls!.label} (${protocol.replace('TLSv', 'TLS ')})`,
        uitleg: MAATREGEL_TEKST.tls!.uitleg,
        ok: /^TLSv1\.[23]$/.test(protocol),
      });
    }

    if (onderdelen.length === 0 && maatregelen.every((m) => m.ok === null) && !sw?.evidence.hosting) continue;
    out.push({
      versie: 1,
      website: site,
      kennisStand: (sw?.evidence.kennisStand as string | null | undefined) ?? null,
      onderdelen,
      maatregelen,
      tls: protocol,
      achterCdn: onderdelen.some((o) => o.categorie === 'cdn'),
      hosting: (sw?.evidence.hosting as HostingInfo | null | undefined) ?? null,
    });
  }
  return out;
}

/** Onderdelen uit één antwoord van een website (voor voorbeelddata en tests; de check doet hetzelfde). */
export function onderdelenUitAntwoord(res: HttpResponse, now: Date, db: VulnDb = sharedVulnDb()): ProfielOnderdeel[] {
  return detectAll(res).map((sw) => profielOnderdeel(sw, beoordeel(sw, now), sw.product ? vulnsFor(sw, db) : []));
}

/** Stand van de kennis over updates (datum van de endoflife.date-snapshot). */
export function kennisStand(): string | null {
  return eolSnapshot()?.stand ?? null;
}
