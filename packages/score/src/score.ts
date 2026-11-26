import {
  ACTIONS,
  BANDS,
  CERTAINTY_FACTOR,
  DIVISOR,
  FALLBACK_WEIGHT,
  MAX_ACTIONS,
  MODEL_VERSION,
  VISIBILITY_FACTOR,
  WEIGHTS,
  type Band,
  type ForWho,
} from './model.ts';
import type { Finding, LinkedVuln, Outcome } from './types.ts';

export interface Contribution {
  fingerprint: string;
  key: string;
  action: string;
  b: number;
  m: number;
  z: number;
  k: number;
  /** b × m × z × k */
  weight: number;
}

export interface TopAction {
  key: string;
  title: string;
  why: string;
  forWho: ForWho;
  weight: number;
  findingCount: number;
  fingerprints: string[];
}

export interface Coverage {
  /** Checks met uitkomst ok of finding. */
  done: number;
  /** Alle checks behalve not_applicable. */
  applicable: number;
  /** 0..100, afgerond. */
  pct: number;
}

export interface ScoreResult {
  modelVersion: string;
  /** Urgentiescore 0..100. Geen "veiligheidsscore": hoger = sneller iets doen. */
  urgency: number;
  band: Pick<Band, 'key' | 'label'>;
  /** True als een KEV-bevinding de band minimaal op Hoge urgentie zette. */
  bandRaisedByKev: boolean;
  totalWeight: number;
  coverage: Coverage;
  contributions: Contribution[];
  topActions: TopAction[];
  /** Aantal acties in totaal (het rapport toont er maximaal MAX_ACTIONS). */
  actionCount: number;
  /** Sleutels zonder gewicht in het model; die tellen mee met FALLBACK_WEIGHT. */
  unknownKeys: string[];
}

export interface ScoreInput {
  findings: Finding[];
  /** Uitkomsten van alle uitgevoerde checks, voor de dekking. */
  outcomes: Outcome[];
}

/** Misbruikfactor m uit het ontwerp. */
export function exploitFactor(vulns: LinkedVuln[] | undefined): number {
  if (!vulns || vulns.length === 0) return 1.0;
  if (vulns.some((v) => v.inKev)) return 2.0;
  if (vulns.some((v) => (v.epss ?? 0) > 0.1 || v.ncscHigh || v.dtcWarning)) return 1.5;
  return 1.0;
}

export function urgencyFromWeight(totalWeight: number): number {
  return Math.round(100 * (1 - Math.exp(-totalWeight / DIVISOR)));
}

export function bandFor(urgency: number): Band {
  let band = BANDS[0]!;
  for (const b of BANDS) if (urgency >= b.min) band = b;
  return band;
}

export function coverageOf(outcomes: Outcome[]): Coverage {
  const applicable = outcomes.filter((o) => o !== 'not_applicable').length;
  const done = outcomes.filter((o) => o === 'ok' || o === 'finding').length;
  return { done, applicable, pct: applicable === 0 ? 0 : Math.round((done / applicable) * 100) };
}

export function score(input: ScoreInput): ScoreResult {
  const unknownKeys = new Set<string>();
  const seen = new Set<string>();
  const contributions: Contribution[] = [];

  for (const f of input.findings) {
    // Dezelfde bevinding twee keer aanleveren mag de score niet verdubbelen.
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);

    let def = WEIGHTS[f.key];
    if (!def) {
      unknownKeys.add(f.key);
      def = FALLBACK_WEIGHT;
    }
    const m = exploitFactor(f.vulns);
    const z = VISIBILITY_FACTOR[f.asset.visibility];
    const k = CERTAINTY_FACTOR[f.certainty];
    contributions.push({
      fingerprint: f.fingerprint,
      key: f.key,
      action: def.action,
      b: def.b,
      m,
      z,
      k,
      weight: def.b * m * z * k,
    });
  }

  const totalWeight = contributions.reduce((s, c) => s + c.weight, 0);
  const urgency = urgencyFromWeight(totalWeight);
  let band = bandFor(urgency);

  const hasKev = input.findings.some((f) => f.vulns?.some((v) => v.inKev));
  let bandRaisedByKev = false;
  const hoog = BANDS.find((b) => b.key === 'hoog')!;
  if (hasKev && band.min < hoog.min) {
    band = hoog;
    bandRaisedByKev = true;
  }

  // Groepeer per actie: één actie lost vaak meerdere bevindingen op.
  const byAction = new Map<string, TopAction>();
  for (const c of contributions) {
    if (c.weight <= 0) continue; // Onbekend (k = 0) levert geen actie op.
    const def = ACTIONS[c.action] ?? {
      title: 'Laat deze bevinding beoordelen door je IT-partner',
      why: 'We hebben iets gevonden waar nog geen vaste uitleg voor is.',
      forWho: 'it-partner' as const,
    };
    const a = byAction.get(c.action) ?? {
      key: c.action,
      title: def.title,
      why: def.why,
      forWho: def.forWho,
      weight: 0,
      findingCount: 0,
      fingerprints: [],
    };
    a.weight += c.weight;
    a.findingCount += 1;
    a.fingerprints.push(c.fingerprint);
    byAction.set(c.action, a);
  }
  const actions = [...byAction.values()].sort(
    (x, y) => y.weight - x.weight || x.key.localeCompare(y.key),
  );

  return {
    modelVersion: MODEL_VERSION,
    urgency,
    band: { key: band.key, label: band.label },
    bandRaisedByKev,
    totalWeight: Math.round(totalWeight * 100) / 100,
    coverage: coverageOf(input.outcomes),
    contributions,
    topActions: actions.slice(0, MAX_ACTIONS),
    actionCount: actions.length,
    unknownKeys: [...unknownKeys].sort(),
  };
}
