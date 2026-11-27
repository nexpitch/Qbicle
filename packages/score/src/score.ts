import {
  ACTIONS,
  ACTION_CAP,
  BANDS,
  CERTAINTY_FACTOR,
  CERT_BROKEN_KEYS,
  COVERAGE_WARN_PCT,
  REPEAT_FACTOR,
  DIVISOR,
  FALLBACK_WEIGHT,
  INFO_MAX_B,
  MAX_ACTIONS,
  PLATFORM_TELT_MEE,
  MODEL_VERSION,
  VISIBILITY_FACTOR,
  WEIGHTS,
  type Band,
  type ForWho,
} from './model.ts';
import type { Finding, LinkedVuln, Outcome, Owner } from './types.ts';

export interface Contribution {
  fingerprint: string;
  key: string;
  action: string;
  b: number;
  m: number;
  z: number;
  k: number;
  /**
   * Herhalingsfactor: 1 voor de zwaarste bevinding per sleutel, REPEAT_FACTOR
   * voor dezelfde sleutel op een ander asset, 0 als een zwaardere
   * certificaatfout op hetzelfde asset al meetelt.
   */
  r: number;
  /**
   * Platformfactor: 0 als alleen het platform dit kan veranderen (owner "platform"),
   * behalve bij PLATFORM_TELT_MEE en een actief misbruikt lek; anders 1.
   */
  p: number;
  /** b × m × z × k × r × p, vóór het plafond per actie */
  weight: number;
  /** Wie het kan oplossen: Finding.owner, of anders de doelgroep van de actie. */
  owner: Owner;
  /** Platform of hostingpartij van het asset, als die bekend is. */
  platform?: string;
  /**
   * Ter info: telt (licht) mee, maar is geen aandachtspunt. Gewicht in het model
   * (b) van INFO_MAX_B of lager, zonder actief misbruikt lek.
   */
  info: boolean;
}

export interface PlatformNote {
  /** Bijvoorbeeld "Wix". */
  platform: string;
  /** Bevindingen die alleen het platform kan veranderen en daarom niet meetellen. */
  fingerprints: string[];
}

export interface TopAction {
  key: string;
  title: string;
  why: string;
  forWho: ForWho;
  /** Gezet als de actie op een platform draait: de klant regelt het dan via dat platform. */
  platform?: string;
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
  /**
   * Gezet als de dekking onder COVERAGE_WARN_PCT ligt: dan is een lage score geen
   * goed nieuws, want een groot deel is niet gecontroleerd. Het rapport toont dit naast de score.
   */
  coverageWarning: string | null;
  /**
   * Per platform de bevindingen die alleen het platform kan veranderen. Geen taak;
   * het rapport toont één regel per platform (leverancierscheck).
   */
  platformNotes: PlatformNote[];
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

  const raw: Omit<Contribution, 'r'>[] = [];
  const platformNotes = new Map<string, string[]>();
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
    const z = f.z ?? VISIBILITY_FACTOR[f.asset.visibility];
    const k = CERTAINTY_FACTOR[f.certainty];
    const kev = f.vulns?.some((v) => v.inKev) === true;
    const owner: Owner = f.owner ?? ACTIONS[def.action]?.forWho ?? 'it-partner';
    const p = owner === 'platform' && !PLATFORM_TELT_MEE.has(f.key) && !kev ? 0 : 1;
    if (p === 0) {
      const naam = f.platform ?? 'je platform';
      platformNotes.set(naam, [...(platformNotes.get(naam) ?? []), f.fingerprint]);
    }
    raw.push({
      fingerprint: f.fingerprint,
      key: f.key,
      action: def.action,
      b: def.b,
      m,
      z,
      k,
      p,
      weight: def.b * m * z * k * p,
      owner,
      ...(f.platform ? { platform: f.platform } : {}),
      info: def.b <= INFO_MAX_B && !kev,
    });
  }

  // Zwaarste eerst, zodat die volledig telt en herhalingen de korting krijgen.
  const assetOf = new Map(input.findings.map((f) => [f.fingerprint, `${f.asset.type}:${f.asset.value}`]));
  const order = raw.map((c, i) => i).sort((a, b) => raw[b]!.weight - raw[a]!.weight || a - b);
  const keySeen = new Set<string>();
  const certBrokenSeen = new Set<string>();
  const factors = new Array<number>(raw.length).fill(1);
  for (const i of order) {
    const c = raw[i]!;
    const asset = assetOf.get(c.fingerprint)!;
    if (CERT_BROKEN_KEYS.has(c.key)) {
      if (certBrokenSeen.has(asset)) {
        factors[i] = 0;
        continue;
      }
      certBrokenSeen.add(asset);
      // Kapot certificaat op een tweede asset telt als herhaling.
      if (keySeen.has('cert.broken')) factors[i] = REPEAT_FACTOR;
      keySeen.add('cert.broken');
      continue;
    }
    if (keySeen.has(c.key)) factors[i] = REPEAT_FACTOR;
    keySeen.add(c.key);
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const r = factors[i]!;
    contributions.push({ ...c, r, weight: Math.round(c.weight * r * 100) / 100 });
  }

  // Plafond per actie.
  const perAction = new Map<string, number>();
  for (const c of contributions) perAction.set(c.action, (perAction.get(c.action) ?? 0) + c.weight);
  const capped = new Map<string, number>();
  for (const [a, w] of perAction) capped.set(a, Math.min(w, ACTION_CAP[a] ?? Infinity));

  const totalWeight = [...capped.values()].reduce((s, w) => s + w, 0);
  const urgency = urgencyFromWeight(totalWeight);
  let band = bandFor(urgency);

  // Alleen een vastgesteld actief misbruikt lek tilt de band op; "mogelijk" telt via m en k mee.
  const hasKev = input.findings.some((f) => f.certainty === 'vastgesteld' && f.vulns?.some((v) => v.inKev));
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
    // Telt een platformbevinding toch mee (certificaat, https, actief lek), dan moet de
    // klant het zelf bij het platform regelen.
    const who: ForWho = c.owner === 'platform' ? 'zelf' : c.owner;
    const a = byAction.get(c.action) ?? {
      key: c.action,
      title: def.title,
      why: def.why,
      forWho: who,
      ...(c.owner === 'platform' && c.platform ? { platform: c.platform } : {}),
      weight: 0,
      findingCount: 0,
      fingerprints: [],
    };
    // Verschillende eigenaren binnen één actie: dan geldt de doelgroep uit het model.
    if (a.findingCount > 0 && a.forWho !== who) a.forWho = def.forWho;
    a.weight += c.weight;
    a.findingCount += 1;
    a.fingerprints.push(c.fingerprint);
    byAction.set(c.action, a);
  }
  for (const a of byAction.values()) a.weight = Math.round((capped.get(a.key) ?? a.weight) * 100) / 100;
  const actions = [...byAction.values()].sort(
    (x, y) => y.weight - x.weight || x.key.localeCompare(y.key),
  );

  const coverage = coverageOf(input.outcomes);
  const coverageWarning =
    coverage.applicable > 0 && coverage.pct < COVERAGE_WARN_PCT
      ? `Let op: we konden maar ${coverage.pct}% van de controles afronden. De score zegt daardoor minder dan normaal; de rest is niet gecontroleerd en dus niet per se in orde.`
      : null;

  return {
    modelVersion: MODEL_VERSION,
    urgency,
    band: { key: band.key, label: band.label },
    bandRaisedByKev,
    totalWeight: Math.round(totalWeight * 100) / 100,
    coverage,
    contributions,
    topActions: actions.slice(0, MAX_ACTIONS),
    actionCount: actions.length,
    unknownKeys: [...unknownKeys].sort(),
    coverageWarning,
    platformNotes: [...platformNotes.entries()]
      .map(([platform, fingerprints]) => ({ platform, fingerprints }))
      .sort((x, y) => x.platform.localeCompare(y.platform)),
  };
}
