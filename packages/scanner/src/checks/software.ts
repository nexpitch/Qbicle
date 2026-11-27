import type { Source } from '@qbicle/score';
import type { VulnDb } from '@qbicle/devices';
import { sharedVulnDb } from '../kennis/index.ts';
import { eolSnapshot } from '../kennis/eol.ts';
import type { Beheerder } from '../kennis/software.ts';
import {
  beoordeel,
  detectAll,
  eolSourcesFor,
  vulnSources,
  vulnsFor,
  type Beoordeling,
  type DetectedSoftware,
  type UpdateStatus,
  type VulnHit,
} from '../software.ts';
import type { Categorie, Zekerheid } from '../stack.ts';
import type { Check, CheckOutput, FindingDraft } from '../types.ts';
import { fetchChain, hostOf, leftDomain, notTheRealPage, type Chain } from './web.ts';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
const maandJaar = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });

/** Eén onderdeel van de website of server, zoals de klant het in het dashboard ziet. */
export interface ProfielOnderdeel {
  key: string;
  naam: string;
  categorie: Categorie;
  /** null als de website de versie niet laat zien. */
  versie: string | null;
  productZekerheid: Zekerheid;
  versieZekerheid: Zekerheid | 'verborgen';
  bron: string;
  /** Wat we letterlijk zagen, voor de IT-partner. */
  ruw: string | null;
  wie: Beheerder;
  status: UpdateStatus;
  reeks?: string;
  ondersteundTot?: string;
  laatsteInReeks?: string;
  nieuwste?: string;
  distributie?: string;
  lekken: { cveId: string; cvss?: number; inKev: boolean; voorwaarde?: string }[];
  /** Gewone taal, voor de klant. */
  uitleg: string;
  /** Technisch, voor de IT-partner of webbouwer. */
  itUitleg: string;
  bronnen: Source[];
}

const WIE_VAN_CATEGORIE: Record<Categorie, Beheerder> = {
  cms: 'webbouwer',
  webwinkel: 'webbouwer',
  plugin: 'webbouwer',
  thema: 'webbouwer',
  'js-bibliotheek': 'webbouwer',
  platform: 'leverancier',
  cdn: 'leverancier',
  taal: 'hosting',
  webserver: 'hosting',
  besturingssysteem: 'hosting',
  'tls-bibliotheek': 'hosting',
};

function uitlegVoor(sw: DetectedSoftware, b: Beoordeling, hits: VulnHit[]): { uitleg: string; it: string } {
  const naam = sw.product?.name ?? sw.rawProduct;
  const v = sw.version;
  const vz = sw.versieZekerheid === 'waarschijnlijk' ? ' (waarschijnlijk)' : '';
  const distro = sw.backportDistro
    ? ` De server meldt ${sw.backportDistro}; die zet beveiligingsfixes vaak terug zonder het versienummer te verhogen, dus of dit echt een probleem is weet alleen je hostingpartij.`
    : '';
  const lekken = hits.length
    ? ` Voor deze versie zijn ${hits.length === 1 ? 'een bekend lek' : `${hits.length} bekende lekken`}${hits.some((h) => h.inKev) ? ', waarvan aanvallers er een actief misbruiken' : ''}.`
    : '';
  const it: string[] = [`Gezien via ${sw.bronUitleg}${sw.rawVersion ? `: ${sw.rawProduct}/${sw.rawVersion}` : ''}.`];
  if (b.eol) it.push(`Reeks ${b.eol.cycle}: ${b.eol.status === 'ondersteund' ? `ondersteund${b.eol.date ? ` tot ${b.eol.date}` : ''}` : `einde ondersteuning${b.eol.date ? ` ${b.eol.date}` : ''}`}.`);
  if (b.laatsteInReeks) it.push(`Nieuwste in reeks: ${b.laatsteInReeks}.`);
  if (b.nieuwste) it.push(`Nieuwste versie: ${b.nieuwste}.`);
  if (hits.length) it.push(`CVE's: ${hits.map((h) => `${h.cveId}${h.cvss ? ` (CVSS ${h.cvss})` : ''}${h.inKev ? ' [CISA KEV]' : ''}`).join(', ')}.`);
  if (sw.backportDistro) it.push(`Distributie ${sw.backportDistro}: controleer de pakketversie (bijv. dpkg -l / rpm -q) in plaats van het upstream-versienummer.`);

  let uitleg: string;
  switch (b.status) {
    case 'beheerd':
      uitleg = `Je website draait op ${naam}. De leverancier werkt de software zelf bij; daar hoef je niets voor te doen. Let wel op de apps en koppelingen die je zelf toevoegt.`;
      if (sw.categorie === 'cdn') {
        uitleg = `Je website gebruikt ${naam} als beschermlaag. De echte server zit daarachter, waardoor we de software daarvan meestal niet zien. Dat is goed, maar betekent niet dat die server is bijgewerkt.`;
      }
      break;
    case 'onbekend':
      uitleg = v
        ? `We zien ${naam} ${v}${vz}, maar hebben nog geen gegevens over updates voor dit product.`
        : `We zien dat je website ${naam} gebruikt, maar niet welke versie. Dat is goed: aanvallers zien het ook niet. Of het is bijgewerkt kunnen we van buitenaf daardoor niet zeggen; vraag het je ${WIE_TEKST[sw.product?.wie ?? WIE_VAN_CATEGORIE[sw.categorie]]}.`;
      break;
    case 'einde':
      uitleg = `${naam} ${v}${vz} krijgt ${b.eol?.date ? `sinds ${maandJaar(b.eol.date)} ` : ''}geen beveiligingsupdates meer. Nieuwe lekken worden niet meer gedicht.${lekken}${distro}`;
      break;
    case 'binnenkort':
      uitleg = `${naam} ${v}${vz} krijgt vanaf ${b.eol?.date ? fmtDate(b.eol.date) : 'binnenkort'} geen beveiligingsupdates meer. Plan de overstap nu.${lekken}${distro}`;
      break;
    case 'achter':
      uitleg = `${naam} ${v}${vz} wordt nog ondersteund, maar er zijn updates die nog niet zijn geïnstalleerd (nieuwste in deze reeks: ${b.laatsteInReeks}).${lekken}${distro}`;
      break;
    case 'nieuwere-reeks':
      uitleg = `${naam} ${v}${vz} krijgt nog beveiligingsupdates${b.eol?.date ? ` tot ${maandJaar(b.eol.date)}` : ''}. Er is een nieuwere versie (${b.nieuwste}); plan de overstap bij het volgende onderhoud.${lekken}${distro}`;
      break;
    case 'actueel':
      uitleg = `${naam} ${v}${vz} is de nieuwste versie en krijgt beveiligingsupdates.${lekken}${distro}`;
      break;
  }
  return { uitleg, it: it.join(' ') };
}

const WIE_TEKST: Record<Beheerder, string> = { hosting: 'hostingpartij', webbouwer: 'webbouwer', leverancier: 'leverancier' };

export function profielOnderdeel(sw: DetectedSoftware, b: Beoordeling, hits: VulnHit[]): ProfielOnderdeel {
  const { uitleg, it } = uitlegVoor(sw, b, hits);
  const p = sw.product;
  return {
    key: p?.key ?? `${sw.categorie}:${sw.rawProduct.toLowerCase()}`,
    naam: p?.name ?? sw.rawProduct,
    categorie: sw.categorie,
    versie: sw.version || null,
    productZekerheid: sw.productZekerheid,
    versieZekerheid: sw.version ? sw.versieZekerheid : 'verborgen',
    bron: sw.bronUitleg,
    ruw: sw.source.startsWith('header:') || sw.source.startsWith('html:') ? `${sw.rawProduct}/${sw.rawVersion}` : null,
    wie: p?.wie ?? WIE_VAN_CATEGORIE[sw.categorie],
    status: b.status,
    ...(b.eol ? { reeks: b.eol.cycle } : {}),
    ...(b.eol?.date ? { ondersteundTot: b.eol.date } : {}),
    ...(b.laatsteInReeks ? { laatsteInReeks: b.laatsteInReeks } : {}),
    ...(b.nieuwste ? { nieuwste: b.nieuwste } : {}),
    ...(sw.backportDistro ? { distributie: sw.backportDistro } : {}),
    lekken: hits.map((h) => ({ cveId: h.cveId, ...(h.cvss ? { cvss: h.cvss } : {}), inKev: h.inKev, ...(h.condition ? { voorwaarde: h.condition } : {}) })),
    uitleg,
    itUitleg: it,
    bronnen: [...(p && b.eol ? eolSourcesFor(p) : []), ...vulnSources(hits)],
  };
}

/**
 * Software van de website en de server: wat draait er, krijgt het nog updates, ontbreken
 * er updates, en zijn er bekende lekken (NVD, CISA KEV), met bronvermelding.
 * Niveau 1: gebruikt hetzelfde ene bezoek als de andere webchecks, probeert niets uit.
 *
 * Sleutels: web.server_* (hostingpartij: PHP, webserver, OpenSSL, besturingssysteem) en
 * web.software_* (webbouwer: CMS, webwinkel). Bibliotheken in de browser (jQuery ...)
 * zonder updates zijn web.bibliotheek_einde; dat weegt lichter.
 */
export function makeSoftwareCheck(db: () => VulnDb = sharedVulnDb): Check {
  return {
    key: 'web.software',
    level: 1,
    group: 'website',
    appliesTo: 'website',
    title: 'Software van de website en server: updates en bekende lekken',
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
      const software = dedupe(hops.flatMap(detectAll));
      const findings: FindingDraft[] = [];
      const onderdelen: ProfielOnderdeel[] = [];

      for (const sw of software) {
        const p = sw.product;
        const hits = p ? vulnsFor(sw, db()) : [];
        const b = beoordeel(sw, ctx.now);
        onderdelen.push(profielOnderdeel(sw, b, hits));
        if (!p || !sw.version) continue;

        const server = p.wie === 'hosting';
        const prefix = server ? 'web.server' : 'web.software';
        const name = `${p.name} ${sw.version}`;
        const guessed = sw.versieZekerheid !== 'zeker' || sw.productZekerheid !== 'zeker';
        const vz = sw.versieZekerheid === 'waarschijnlijk' ? ' (waarschijnlijk)' : '';
        const backport = sw.backportDistro
          ? ` Let op: de server meldt ${sw.backportDistro}. Zo'n distributie zet beveiligingsfixes vaak terug zonder het versienummer te verhogen, dus vraag je hostingpartij of de updates van ${sw.backportDistro} zijn geïnstalleerd.`
          : '';
        const seenVia = `De website meldt ${name}${vz} (${sw.bronUitleg})`;

        if (hits.length > 0) {
          const conditional = hits.every((h) => h.condition);
          const certainty = sw.backportDistro || conditional || guessed ? 'mogelijk' : 'vastgesteld';
          const list = hits
            .map((h) => `${h.cveId}${h.cvss ? ` (CVSS ${h.cvss})` : ''}${h.inKev ? ', wordt actief misbruikt' : ''}${h.condition ? `; ${h.condition}` : ''}`)
            .join('; ');
          findings.push({
            key: `${prefix}_kwetsbaar`,
            certainty,
            discriminator: p.key,
            title: hits.some((h) => h.inKev) ? `${name} heeft een lek dat aanvallers actief misbruiken` : `${name} heeft bekende lekken`,
            detail: `${seenVia}. Voor die versie zijn deze lekken bekend: ${list}.${backport}`,
            vulns: hits.map((h) => h.linked),
            sources: vulnSources(hits),
          });
        }

        const eol = b.eol;
        if (eol && (b.status === 'einde' || b.status === 'binnenkort')) {
          const when = eol.date ? fmtDate(eol.date) : undefined;
          // Distributies (Ubuntu, Debian, Red Hat) ondersteunen hun eigen versies vaak jaren langer
          // dan de maker (nginx 1.24 in Ubuntu 24.04 tot 2029). Welke distributieversie draait,
          // zien we niet: dan tonen we het wel, maar het telt niet mee in de score.
          const key = sw.backportDistro
            ? `${prefix}_einde_distro`
            : p.bibliotheek
              ? b.status === 'einde'
                ? 'web.bibliotheek_einde'
                : null
              : b.status === 'einde'
                ? `${prefix}_einde_ondersteuning`
                : `${prefix}_einde_binnenkort`;
          if (key) {
            findings.push({
              key,
              certainty: sw.backportDistro || guessed ? 'mogelijk' : 'vastgesteld',
              discriminator: p.key,
              title:
                b.status === 'einde'
                  ? `${p.name} ${eol.cycle} krijgt geen beveiligingsupdates meer`
                  : `${p.name} ${eol.cycle} krijgt binnenkort geen beveiligingsupdates meer`,
              detail:
                (b.status === 'einde'
                  ? `${seenVia}. De makers stoppen${when ? ` sinds ${when}` : ''} met beveiligingsupdates voor reeks ${eol.cycle}; nieuwe lekken worden dan niet meer gedicht.`
                  : `${seenVia}. Op ${when} stoppen de beveiligingsupdates voor reeks ${eol.cycle}; plan de overstap nu.`) +
                (p.bibliotheek ? ' Deze bibliotheek draait in de browser van je bezoekers; je webbouwer kan hem vervangen door een ondersteunde versie.' : '') +
                backport,
              sources: eolSourcesFor(p),
            });
          }
        }

        // Ondersteunde reeks, maar de beveiligingsupdates die er al zijn ontbreken.
        // Niet bij een distributie (die nummert anders) en niet bij bibliotheken (nieuwe versie is niet altijd een fix).
        if (b.status === 'achter' && !sw.backportDistro && !p.bibliotheek && hits.length === 0) {
          findings.push({
            key: `${prefix}_update_achter`,
            certainty: guessed ? 'mogelijk' : 'vastgesteld',
            discriminator: p.key,
            title: `${name} mist beschikbare updates`,
            detail: `${seenVia}. Reeks ${eol!.cycle} wordt nog ondersteund, maar de nieuwste versie daarin is ${b.laatsteInReeks}. Die updates bevatten vaak beveiligingsfixes.`,
            sources: eolSourcesFor(p),
          });
        }
      }

      const evidence = {
        software: software.map((s) => ({
          product: s.product?.name ?? s.rawProduct,
          version: s.version,
          raw: `${s.rawProduct}/${s.rawVersion}`,
          source: s.source,
          backportDistro: s.backportDistro,
        })),
        profiel: onderdelen,
        kennisStand: eolSnapshot()?.stand ?? null,
      };
      if (software.length === 0 && chain.leftDomainTo) return leftDomain(chain);
      if (software.length === 0) {
        return {
          outcome: 'not_applicable',
          evidence,
          message: 'De website vertelt niet welke software hij gebruikt; dan kunnen we dit niet van buitenaf beoordelen.',
        };
      }
      return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
    },
  };
}

function dedupe(list: DetectedSoftware[]): DetectedSoftware[] {
  const m = new Map<string, DetectedSoftware>();
  for (const s of list) {
    const k = `${s.categorie === 'besturingssysteem' ? 'os:' : ''}${s.product?.key ?? `${s.categorie}:${s.rawProduct.toLowerCase()}`}`;
    const cur = m.get(k);
    if (!cur || (!cur.version && s.version)) m.set(k, s);
  }
  return [...m.values()];
}

export const softwareCheck = makeSoftwareCheck();
