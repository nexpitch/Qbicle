import type { Finding, Owner } from '@qbicle/score';
import type { HostingInfo, HostingSoort } from './hosting.ts';
import type { CheckResult } from './types.ts';

/**
 * Wie kan een bevinding oplossen, per hostingtype. Uit het advies "Wat kan de klant
 * zelf doen? Bevindingen per hostingtype" (27-11-2026, akkoord Erik):
 *
 * - DNS en mail zijn overal van de klant;
 * - op een websiteplatform (Wix, Shopify ...) is de website van het platform;
 * - bij gedeelde hosting liggen headers en cookies bij de webbouwer, TLS en de server bij de hoster;
 * - op een eigen server in de cloud ligt alles bij de IT-partner, behalve het CMS (webbouwer).
 *
 * Kennen we het hostingtype niet (of zit er alleen een beschermlaag voor), dan zetten we
 * geen eigenaar en geldt de doelgroep van de actie in het scoremodel.
 */

type Soort = 'domein' | 'certificaat' | 'tls' | 'website' | 'server' | 'software' | 'zelf';

function soortVan(key: string): Soort {
  if (/^(spf|dmarc|dkim|dnssec|caa)\./.test(key)) return 'domein';
  if (key.startsWith('cert.')) return 'certificaat';
  if (key.startsWith('tls.')) return 'tls';
  if (key.startsWith('web.securitytxt')) return 'zelf';
  if (key === 'web.version_disclosed' || key.startsWith('web.server_')) return 'server';
  if (key.startsWith('web.software_') || key.startsWith('web.bibliotheek')) return 'software';
  return 'website';
}

const PER_HOSTING: Record<Exclude<Soort, 'domein' | 'zelf'>, Partial<Record<HostingSoort, Owner>>> = {
  certificaat: { platform: 'platform', 'beheerde-wordpress': 'hosting', hosting: 'hosting', statisch: 'hosting', cloud: 'it-partner' },
  tls: { platform: 'platform', 'beheerde-wordpress': 'hosting', hosting: 'hosting', statisch: 'hosting', cloud: 'it-partner' },
  website: { platform: 'platform', 'beheerde-wordpress': 'webbouwer', hosting: 'webbouwer', statisch: 'webbouwer', cloud: 'it-partner' },
  server: { platform: 'platform', 'beheerde-wordpress': 'hosting', hosting: 'hosting', statisch: 'hosting', cloud: 'it-partner' },
  software: { platform: 'platform', 'beheerde-wordpress': 'webbouwer', hosting: 'webbouwer', statisch: 'webbouwer', cloud: 'webbouwer' },
};

export function ownerFor(key: string, hosting: Pick<HostingInfo, 'soort'> | null | undefined): Owner | undefined {
  const s = soortVan(key);
  if (s === 'domein' || s === 'zelf') return 'zelf';
  if (!hosting) return undefined;
  return PER_HOSTING[s][hosting.soort];
}

/** Hostingpartij per website, uit het bewijs van de softwarecheck. */
export function hostingPerAsset(checks: CheckResult[]): Map<string, HostingInfo> {
  const m = new Map<string, HostingInfo>();
  for (const c of checks) {
    const h = (c.evidence as { hosting?: HostingInfo | null } | undefined)?.hosting;
    if (c.checkKey === 'web.software' && h) m.set(c.asset.value, h);
  }
  return m;
}

/** Zet eigenaar en platform op elke bevinding. Een eigenaar die al gezet is, blijft staan. */
export function assignOwners(findings: Finding[], hosting: Map<string, HostingInfo>): Finding[] {
  return findings.map((f) => {
    if (f.owner) return f;
    const h = hosting.get(f.asset.value);
    const owner = ownerFor(f.key, h);
    if (!owner) return f;
    return { ...f, owner, ...(h && owner !== 'zelf' ? { platform: h.naam } : {}) };
  });
}
