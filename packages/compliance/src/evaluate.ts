import type { FindingDraft } from '@qbicle/scanner';
import type { Outcome } from '@qbicle/score';
import { isConsentCookie, needsConsent, trackerForCookie, trackerForRequest, type TrackerDef } from './trackers.ts';
import type { ConsentObservations, VisitObservation } from './types.ts';

/**
 * Beoordeelt de drie bezoeken. Pure functie: geen netwerk, geen browser.
 *
 * Belangrijk: dit is een technische waarneming, geen juridisch oordeel. Een
 * analytische cookie kan bijvoorbeeld zonder toestemming mogen als hij
 * privacyvriendelijk is ingesteld; dat zien wij van buiten niet, dus zo'n
 * bevinding krijgt zekerheid "mogelijk". [jurist]
 */

export interface ComplianceCheckResult {
  checkKey: string;
  title: string;
  /** Regels of normen waar deze controle bij hoort. */
  norms: string[];
  outcome: Outcome;
  findings: FindingDraft[];
  message?: string;
}

export interface SeenTracker {
  name: string;
  vendor: string;
  category: TrackerDef['category'];
  cookies: string[];
  hosts: string[];
  /** Alle meetverzoeken naar Google gaven via Consent Mode "geweigerd" door. */
  consentModeDenied?: boolean;
}

export interface ConsentEvaluation {
  checks: ComplianceCheckResult[];
  /** Per scenario de trackers die toestemming vragen. */
  seen: Record<VisitObservation['scenario'], SeenTracker[]>;
  /** Cookies van derden die we niet herkennen: tonen, niet meerekenen. */
  unknownThirdPartyCookies: string[];
  /** Klopt de meting? Als accepteren niets verandert, is de klik misschien niet aangekomen. */
  measurementNote?: string;
}

const NORMS_COOKIES = ['Telecommunicatiewet art. 11.7a', 'AVG art. 4 lid 11 en art. 7', 'Richtlijnen AP cookiebanners'];

/** Trackers die toestemming vragen en die we in dit bezoek zagen. */
export function trackersIn(visit: VisitObservation): SeenTracker[] {
  const byName = new Map<string, SeenTracker>();
  const get = (t: TrackerDef) => {
    let s = byName.get(t.name);
    if (!s) {
      s = { name: t.name, vendor: t.vendor, category: t.category, cookies: [], hosts: [] };
      byName.set(t.name, s);
    }
    return s;
  };
  for (const c of visit.cookies) {
    if (isConsentCookie(c.name)) continue;
    const t = trackerForCookie(c);
    if (t && needsConsent(t.category)) {
      const s = get(t);
      if (!s.cookies.includes(c.name)) s.cookies.push(c.name);
    }
  }
  const gaSignals: string[] = [];
  for (const r of visit.requests) {
    if (r.blocked || !r.thirdParty) continue;
    const t = trackerForRequest(r);
    if (t && needsConsent(t.category)) {
      const s = get(t);
      if (!s.hosts.includes(r.host)) s.hosts.push(r.host);
      if (t.id === 'google-analytics') gaSignals.push(new URL(r.url).searchParams.get('gcs') ?? '');
    }
  }
  const ga = byName.get('Google Analytics');
  if (ga && gaSignals.length > 0 && ga.cookies.length === 0 && gaSignals.every((g) => /^G1[0-1]0$/.test(g))) {
    // gcs=G100 / G110: analytics_storage geweigerd. Google meet dan zonder cookies ("cookieless pings").
    ga.consentModeDenied = true;
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function trackerFinding(key: string, t: SeenTracker, moment: string, titleSuffix: string): FindingDraft {
  const what = [
    t.cookies.length ? `cookies ${t.cookies.join(', ')}` : '',
    t.hosts.length ? `verzoeken naar ${t.hosts.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' en ');
  let certainty: FindingDraft['certainty'] = t.category === 'marketing' ? 'vastgesteld' : 'mogelijk';
  let detail = `${moment} zagen we ${t.name} (${t.vendor}): ${what}.`;
  if (t.category === 'analytisch') {
    detail +=
      ' Analytische cookies mogen soms zonder toestemming, als ze privacyvriendelijk zijn ingesteld. Dat kunnen we van buiten niet zien.';
  } else {
    detail += ' Dit soort tracking vraagt vooraf toestemming van de bezoeker.';
  }
  if (t.consentModeDenied) {
    certainty = 'mogelijk';
    detail +=
      ' De site geeft via Google Consent Mode wel door dat de bezoeker niet heeft ingestemd; Google meet dan zonder cookies. Of dat voldoende is, is een juridische vraag.';
  }
  return { key, certainty, title: `${t.name} ${titleSuffix}`, detail, discriminator: t.name };
}

function failed(v: VisitObservation): string | undefined {
  if (v.error) return `De pagina kon niet goed worden geladen: ${v.error}`;
  if (!v.loaded) return 'De pagina kon niet worden geladen.';
  return undefined;
}

export function evaluateConsent(obs: ConsentObservations): ConsentEvaluation {
  const { visits, domain } = obs;
  const seen = {
    'geen-keuze': trackersIn(visits['geen-keuze']),
    weigeren: trackersIn(visits.weigeren),
    accepteren: trackersIn(visits.accepteren),
  };
  const checks: ComplianceCheckResult[] = [];

  // 1. Niets vóór toestemming
  {
    const v = visits['geen-keuze'];
    const err = failed(v);
    const base = { checkKey: 'consent.voor_keuze', title: 'Geen tracking vóór toestemming', norms: NORMS_COOKIES };
    if (err) checks.push({ ...base, outcome: 'unknown', findings: [], message: err });
    else {
      const findings = seen['geen-keuze'].map((t) =>
        trackerFinding('consent.tracking_before_consent', t, 'Voordat de bezoeker een keuze maakte', 'actief vóór toestemming'),
      );
      checks.push({ ...base, outcome: findings.length ? 'finding' : 'ok', findings });
    }
  }

  // 2. Weigeren even makkelijk als accepteren
  {
    const v = visits['geen-keuze'];
    const base = {
      checkKey: 'consent.weigeroptie',
      title: 'Weigeren is even makkelijk als accepteren',
      norms: ['Richtlijnen AP cookiebanners', 'EDPB Cookie Banner Taskforce (2023)'],
    };
    const anyTracking = seen['geen-keuze'].length + seen.weigeren.length + seen.accepteren.length > 0;
    const err = failed(v);
    if (err) checks.push({ ...base, outcome: 'unknown', findings: [], message: err });
    else if (!v.banner.found && !anyTracking) {
      checks.push({
        ...base,
        outcome: 'not_applicable',
        findings: [],
        message: 'We zagen geen cookiebanner en ook geen tracking waarvoor toestemming nodig is.',
      });
    } else if (!v.banner.found) {
      checks.push({
        ...base,
        outcome: 'finding',
        findings: [
          {
            key: 'consent.banner_missing',
            certainty: 'mogelijk',
            title: 'Geen cookiebanner gevonden, wel tracking',
            detail:
              'De site gebruikt tracking waarvoor toestemming nodig is, maar we vonden geen cookiebanner met een knop om te accepteren of te weigeren. Misschien herkennen we de banner niet; controleer het zelf.',
          },
        ],
      });
    } else if (!v.banner.rejectFound) {
      checks.push({
        ...base,
        outcome: 'finding',
        findings: [
          {
            key: 'consent.no_reject_first_layer',
            certainty: 'mogelijk',
            title: 'Geen weigerknop naast de akkoordknop',
            detail: `De cookiebanner heeft een knop "${v.banner.acceptText ?? 'accepteren'}", maar we vonden op dezelfde plek geen knop om te weigeren. Bezoekers moeten even makkelijk kunnen weigeren als accepteren.`,
          },
        ],
      });
    } else {
      checks.push({ ...base, outcome: 'ok', findings: [] });
    }
  }

  // 3. Niets na weigeren
  {
    const v = visits.weigeren;
    const base = { checkKey: 'consent.na_weigeren', title: 'Geen tracking na weigeren', norms: NORMS_COOKIES };
    const err = failed(v);
    if (err) checks.push({ ...base, outcome: 'unknown', findings: [], message: err });
    else if (!v.banner.found && seen['geen-keuze'].length === 0 && seen.weigeren.length === 0) {
      checks.push({ ...base, outcome: 'not_applicable', findings: [], message: 'Geen cookiebanner en geen tracking gezien.' });
    } else if (!v.clicked?.ok) {
      checks.push({
        ...base,
        outcome: 'unknown',
        findings: [],
        message: v.clicked
          ? `We konden niet op de weigerknop klikken: ${v.clicked.error ?? 'onbekende fout'}.`
          : 'We vonden geen weigerknop, dus we konden niet controleren wat er na weigeren gebeurt.',
      });
    } else {
      const findings = seen.weigeren.map((t) => trackerFinding('consent.tracking_after_reject', t, 'Nadat de bezoeker weigerde', 'actief na weigeren'));
      checks.push({ ...base, outcome: findings.length ? 'finding' : 'ok', findings });
    }
  }

  // Controle op de meting zelf: accepteren moet normaal iets veranderen.
  let measurementNote: string | undefined;
  const acc = visits.accepteren;
  if (acc.clicked?.ok && seen.accepteren.length === 0 && seen['geen-keuze'].length === 0) {
    measurementNote =
      'Ook na accepteren zagen we geen tracking. Dat kan kloppen (de site meet niets), of de klik is niet aangekomen.';
  } else if (acc.clicked && !acc.clicked.ok) {
    measurementNote = `We konden niet op de akkoordknop klikken: ${acc.clicked.error ?? 'onbekende fout'}.`;
  }

  const unknown = new Set<string>();
  for (const v of Object.values(visits)) {
    for (const c of v.cookies) {
      const cd = c.domain.replace(/^\./, '');
      const firstParty = cd === domain || cd.endsWith(`.${domain}`) || domain.endsWith(`.${cd}`);
      if (!firstParty && !isConsentCookie(c.name) && !trackerForCookie(c)) unknown.add(`${c.name} (${cd})`);
    }
  }

  return { checks, seen, unknownThirdPartyCookies: [...unknown].sort(), measurementNote };
}
