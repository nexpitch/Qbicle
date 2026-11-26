import type { VulnDb } from '@qbicle/devices';
import { sharedVulnDb } from '../kennis/index.ts';
import { assessEol, detectSoftware, vulnSources, vulnsFor, type DetectedSoftware } from '../software.ts';
import type { Check, CheckOutput, FindingDraft } from '../types.ts';
import { fetchChain, hostOf, leftDomain, notTheRealPage, type Chain } from './web.ts';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Softwareversies die de website prijsgeeft, gekoppeld aan bekende lekken (NVD,
 * CISA KEV) en aan einde-ondersteuning, met bronvermelding. Niveau 1: gebruikt
 * hetzelfde ene bezoek als de andere webchecks, probeert niets uit.
 */
export function makeSoftwareCheck(db: () => VulnDb = sharedVulnDb): Check {
  return {
    key: 'web.software',
    level: 1,
    group: 'website',
    appliesTo: 'website',
    title: 'Software van de website: bekende lekken en updates',
    async run(ctx): Promise<CheckOutput> {
      const host = hostOf(ctx.asset);
      let chain: Chain;
      try {
        chain = await fetchChain(ctx, `https://${host}/`);
      } catch (e) {
        return {
          outcome: 'unknown',
          evidence: { error: (e as { code?: string }).code ?? String(e) },
          message: `We kregen geen antwoord van https://${host}, dus dit is niet gecontroleerd.`,
        };
      }
      // Alleen antwoorden van het eigen domein; een foutpagina van botbescherming
      // kan van een andere server komen dan de website zelf.
      const hops = chain.hops.filter((h) => h.status < 400);
      if (hops.length === 0) {
        const bad = notTheRealPage(chain.final);
        if (bad) return bad;
      }
      const software = dedupe(hops.flatMap(detectSoftware));
      const known = software.filter((s) => s.product);
      const evidence = {
        software: software.map((s) => ({
          product: s.product?.name ?? s.rawProduct,
          version: s.version,
          raw: `${s.rawProduct}/${s.rawVersion}`,
          source: s.source,
          backportDistro: s.backportDistro,
        })),
      };
      if (software.length === 0 && chain.leftDomainTo) return leftDomain(chain);
      if (known.length === 0) {
        return {
          outcome: software.length === 0 ? 'not_applicable' : 'ok',
          evidence,
          message:
            software.length === 0
              ? 'De website vertelt niet welke software en versie hij gebruikt; dan kunnen we dit niet van buitenaf beoordelen.'
              : 'De software die we zien staat (nog) niet in onze kennisbank.',
        };
      }

      const findings: FindingDraft[] = [];
      for (const sw of known) {
        const name = `${sw.product!.name} ${sw.version}`;
        const backport = sw.backportDistro
          ? ` Let op: de server meldt ${sw.backportDistro}. Zo'n distributie zet beveiligingsfixes vaak terug zonder het versienummer te verhogen, dus vraag je beheerder of de updates van ${sw.backportDistro} zijn geïnstalleerd.`
          : '';
        const hits = vulnsFor(sw, db());
        if (hits.length > 0) {
          const conditional = hits.every((h) => h.condition);
          const certainty = sw.backportDistro || conditional ? 'mogelijk' : 'vastgesteld';
          const list = hits
            .map((h) => `${h.cveId}${h.cvss ? ` (CVSS ${h.cvss})` : ''}${h.inKev ? ', wordt actief misbruikt' : ''}${h.condition ? `; ${h.condition}` : ''}`)
            .join('; ');
          findings.push({
            key: 'web.software_kwetsbaar',
            certainty,
            discriminator: sw.product!.key,
            title: hits.some((h) => h.inKev)
              ? `${name} heeft een lek dat aanvallers actief misbruiken`
              : `${name} heeft bekende lekken`,
            detail: `De website meldt ${name} (${sw.source}). Voor die versie zijn deze lekken bekend: ${list}.${backport}`,
            vulns: hits.map((h) => h.linked),
            sources: vulnSources(hits),
          });
        }
        const eol = assessEol(sw, ctx.now);
        if (eol && eol.status !== 'ondersteund') {
          const when = eol.date ? fmtDate(eol.date) : undefined;
          findings.push({
            key: eol.status === 'einde' ? 'web.software_einde_ondersteuning' : 'web.software_einde_binnenkort',
            certainty: sw.backportDistro ? 'mogelijk' : 'vastgesteld',
            discriminator: sw.product!.key,
            title:
              eol.status === 'einde'
                ? `${sw.product!.name} ${eol.cycle} krijgt geen beveiligingsupdates meer`
                : `${sw.product!.name} ${eol.cycle} krijgt binnenkort geen beveiligingsupdates meer`,
            detail:
              (eol.status === 'einde'
                ? `De website meldt ${name}. De makers stoppen${when ? ` sinds ${when}` : ''} met beveiligingsupdates voor reeks ${eol.cycle}; nieuwe lekken worden dan niet meer gedicht.`
                : `De website meldt ${name}. Op ${when} stoppen de beveiligingsupdates voor reeks ${eol.cycle}; plan de overstap nu.`) + backport,
            sources: sw.product!.eolSources,
          });
        }
      }
      return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
    },
  };
}

function dedupe(list: DetectedSoftware[]): DetectedSoftware[] {
  const m = new Map<string, DetectedSoftware>();
  for (const s of list) {
    const k = `${s.product?.key ?? s.rawProduct.toLowerCase()}/${s.version}`;
    if (!m.has(k)) m.set(k, s);
  }
  return [...m.values()];
}

export const softwareCheck = makeSoftwareCheck();
