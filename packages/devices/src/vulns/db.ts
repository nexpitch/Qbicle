import type { LinkedVuln } from '@qbicle/score';
import { parseCpe, type Component } from './cpe.ts';
import { compareVersions, hasRange, inRange, type VersionRange } from './version.ts';

/**
 * Lokale kwetsbaarheidsdatabase: NVD (CVE + CPE-bereiken), CISA KEV, EPSS en
 * NCSC-adviezen. Wordt gevuld uit snapshots die een periodieke taak ophaalt
 * (fase 4); hier alleen inlezen en koppelen. Er gaat niets over klanten naar buiten.
 */
export interface CpeMatch extends VersionRange {
  criteria: string;
  vulnerable: boolean;
}

export interface CveRecord {
  id: string;
  cvss?: number;
  description?: string;
  matches: CpeMatch[];
}

export interface NcscAdvisory {
  /** Bijvoorbeeld "NCSC-2026-0123". */
  id: string;
  cves: string[];
  /** Kans en schade volgens het NCSC. */
  kans: 'hoog' | 'middel' | 'laag';
  schade: 'hoog' | 'middel' | 'laag';
}

export interface KevEntry {
  cveId: string;
  dateAdded?: string;
  ransomware?: boolean;
}

export interface ComponentVuln {
  component: Component;
  cve: CveRecord;
  /** vastgesteld: exacte versie valt in het bereik; mogelijk: versie onbekend of product geraden. */
  certainty: 'vastgesteld' | 'mogelijk';
  linked: LinkedVuln;
  ncsc?: NcscAdvisory;
  kev?: KevEntry;
}

export class VulnDb {
  private readonly byProduct = new Map<string, CveRecord[]>();
  private readonly kev = new Map<string, KevEntry>();
  private readonly epss = new Map<string, number>();
  private readonly ncsc = new Map<string, NcscAdvisory>();

  /** NVD CVE API 2.0 (antwoord of datafeed): { vulnerabilities: [{ cve: {...} }] }. */
  addNvd(doc: unknown): number {
    const items = (doc as { vulnerabilities?: Array<{ cve?: NvdCve }> }).vulnerabilities ?? [];
    let n = 0;
    for (const { cve } of items) {
      if (!cve?.id) continue;
      const matches: CpeMatch[] = [];
      for (const conf of cve.configurations ?? []) {
        for (const node of conf.nodes ?? []) {
          if (node.negate) continue;
          for (const m of node.cpeMatch ?? []) if (m.criteria) matches.push(m as CpeMatch);
        }
      }
      const metrics = cve.metrics ?? {};
      const cvss = (metrics.cvssMetricV40 ?? metrics.cvssMetricV31 ?? metrics.cvssMetricV30 ?? metrics.cvssMetricV2)?.[0]?.cvssData?.baseScore;
      const record: CveRecord = {
        id: cve.id,
        cvss,
        description: cve.descriptions?.find((d) => d.lang === 'en')?.value,
        matches,
      };
      for (const key of new Set(matches.filter((m) => m.vulnerable).map((m) => productKey(m.criteria)).filter(Boolean) as string[])) {
        const list = this.byProduct.get(key) ?? [];
        list.push(record);
        this.byProduct.set(key, list);
      }
      n++;
    }
    return n;
  }

  /** CISA Known Exploited Vulnerabilities, JSON-catalogus. */
  addKev(doc: unknown): number {
    const items = (doc as { vulnerabilities?: Array<{ cveID?: string; dateAdded?: string; knownRansomwareCampaignUse?: string }> }).vulnerabilities ?? [];
    for (const v of items) {
      if (v.cveID) this.kev.set(v.cveID, { cveId: v.cveID, dateAdded: v.dateAdded, ransomware: v.knownRansomwareCampaignUse === 'Known' });
    }
    return items.length;
  }

  /** EPSS-CSV van FIRST: "cve,epss,percentile", met een commentaarregel bovenaan. */
  addEpssCsv(csv: string): number {
    let n = 0;
    for (const line of csv.split(/\r?\n/)) {
      const [cve, score] = line.split(',');
      if (!cve?.startsWith('CVE-') || !score) continue;
      const v = Number(score);
      if (Number.isFinite(v)) {
        this.epss.set(cve, v);
        n++;
      }
    }
    return n;
  }

  /** NCSC-adviezen, al vertaald naar kans/schade per advies. */
  addNcsc(advisories: NcscAdvisory[]): number {
    for (const a of advisories) for (const cve of a.cves) this.ncsc.set(cve, a);
    return advisories.length;
  }

  /** Koppelt componenten aan CVE's. */
  match(components: Component[]): ComponentVuln[] {
    const out: ComponentVuln[] = [];
    for (const component of components) {
      const parts = parseCpe(component.cpe);
      if (!parts) continue;
      const key = `${parts.part}:${parts.vendor}:${parts.product}`;
      for (const cve of this.byProduct.get(key) ?? []) {
        const hit = this.matchCve(cve, component, key);
        if (!hit) continue;
        // Zonder versie zou elk lek ooit in dit product meetellen. Dan alleen wat actief misbruikt wordt (KEV).
        if (hit === 'zonder-versie' && !this.kev.has(cve.id)) continue;
        const certainty = hit === 'versie' && component.cpeCertainty === 'vastgesteld' ? 'vastgesteld' : 'mogelijk';
        out.push({ component, cve, certainty, linked: this.linked(cve), ncsc: this.ncsc.get(cve.id), kev: this.kev.get(cve.id) });
      }
    }
    return out.sort((a, b) => Number(Boolean(b.kev)) - Number(Boolean(a.kev)) || (b.cve.cvss ?? 0) - (a.cve.cvss ?? 0) || a.cve.id.localeCompare(b.cve.id));
  }

  private matchCve(cve: CveRecord, component: Component, key: string): 'versie' | 'zonder-versie' | undefined {
    for (const m of cve.matches) {
      if (!m.vulnerable || productKey(m.criteria) !== key) continue;
      const exact = parseCpe(m.criteria)!.version.replace(/\\/g, '');
      if (!component.version) return 'zonder-versie';
      if (exact !== '*' && exact !== '-') {
        if (compareVersions(component.version, exact) === 0) return 'versie';
        continue;
      }
      // "*" zonder bereik = alle versies volgens NVD; met bereik moet de versie erin vallen.
      if (!hasRange(m) || inRange(component.version, m)) return 'versie';
    }
    return undefined;
  }

  linked(cve: CveRecord): LinkedVuln {
    const ncsc = this.ncsc.get(cve.id);
    return {
      cveId: cve.id,
      cvss: cve.cvss,
      inKev: this.kev.has(cve.id),
      epss: this.epss.get(cve.id),
      ncscHigh: ncsc ? ncsc.kans === 'hoog' : undefined,
    };
  }

  get stats(): { products: number; kev: number; epss: number; ncsc: number } {
    return { products: this.byProduct.size, kev: this.kev.size, epss: this.epss.size, ncsc: this.ncsc.size };
  }
}

function productKey(criteria: string): string | undefined {
  const p = parseCpe(criteria);
  return p ? `${p.part}:${p.vendor}:${p.product}` : undefined;
}

interface NvdCve {
  id?: string;
  descriptions?: Array<{ lang: string; value: string }>;
  metrics?: Record<string, Array<{ cvssData?: { baseScore?: number } }> | undefined>;
  configurations?: Array<{ nodes?: Array<{ negate?: boolean; cpeMatch?: Array<Partial<CpeMatch>> }> }>;
}
