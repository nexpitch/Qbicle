import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Meetbare limieten. Namen zoals in usage_limit_override.metric. */
export const LIMIT_METRICS = ['scans_maand', 'api_dag', 'ai_tokens_maand', 'ai_kosten_maand'] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

/** null = onbeperkt. ai_kosten_maand in euro's. */
export type Limits = Record<LimitMetric, number | null>;

export interface ModelPrice {
  /** Dollars per miljoen tokens. */
  invoer: number;
  uitvoer: number;
  cacheLezen: number;
  cacheSchrijven: number;
}

export interface UsageConfig {
  limieten: Record<string, Limits>;
  kosten: {
    dollarNaarEuro: number;
    perScanEuro: number;
    perMailEuro: number;
    aiModellen: Record<string, ModelPrice>;
  };
  signalen: {
    factor: number;
    minimum: { api: number; ai_tokens: number; scans: number };
    limietWaarschuwingProcent: number;
    scanVastNaMinuten: number;
    scanWachtrijTeLangNaMinuten: number;
  };
}

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '../../../config/gebruik.json');

function fail(msg: string): never {
  throw new Error(`config/gebruik.json: ${msg}`);
}

function num(v: unknown, path: string, nullable = false): number | null {
  if (v === null && nullable) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`${path} moet een getal >= 0${nullable ? ' of null' : ''} zijn`);
  return v;
}

export function parseUsageConfig(raw: unknown): UsageConfig {
  const r = raw as Record<string, any>;
  if (!r || typeof r !== 'object') fail('geen object');
  const limieten: Record<string, Limits> = {};
  for (const [plan, l] of Object.entries(r.limieten ?? {})) {
    const out = {} as Limits;
    for (const m of LIMIT_METRICS) out[m] = num((l as any)?.[m], `limieten.${plan}.${m}`, true);
    limieten[plan] = out;
  }
  if (!limieten.gratis) fail("limieten.gratis ontbreekt (vangnet voor klanten zonder pakket)");
  const k = r.kosten ?? fail('kosten ontbreekt');
  const aiModellen: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(k.aiModellen ?? {})) {
    const q = p as any;
    aiModellen[model] = {
      invoer: num(q?.invoer, `kosten.aiModellen.${model}.invoer`)!,
      uitvoer: num(q?.uitvoer, `kosten.aiModellen.${model}.uitvoer`)!,
      cacheLezen: num(q?.cacheLezen, `kosten.aiModellen.${model}.cacheLezen`)!,
      cacheSchrijven: num(q?.cacheSchrijven, `kosten.aiModellen.${model}.cacheSchrijven`)!,
    };
  }
  const s = r.signalen ?? fail('signalen ontbreekt');
  return {
    limieten,
    kosten: {
      dollarNaarEuro: num(k.dollarNaarEuro, 'kosten.dollarNaarEuro')!,
      perScanEuro: num(k.perScanEuro, 'kosten.perScanEuro')!,
      perMailEuro: num(k.perMailEuro, 'kosten.perMailEuro')!,
      aiModellen,
    },
    signalen: {
      factor: num(s.factor, 'signalen.factor')!,
      minimum: {
        api: num(s.minimum?.api, 'signalen.minimum.api')!,
        ai_tokens: num(s.minimum?.ai_tokens, 'signalen.minimum.ai_tokens')!,
        scans: num(s.minimum?.scans, 'signalen.minimum.scans')!,
      },
      limietWaarschuwingProcent: num(s.limietWaarschuwingProcent, 'signalen.limietWaarschuwingProcent')!,
      scanVastNaMinuten: num(s.scanVastNaMinuten, 'signalen.scanVastNaMinuten')!,
      scanWachtrijTeLangNaMinuten: num(s.scanWachtrijTeLangNaMinuten, 'signalen.scanWachtrijTeLangNaMinuten')!,
    },
  };
}

export function loadUsageConfig(file = process.env.QBICLE_GEBRUIK_BESTAND || DEFAULT_FILE): UsageConfig {
  return parseUsageConfig(JSON.parse(readFileSync(file, 'utf8')));
}

/** Micro-euro's (1 euro = 1.000.000) naar euro's, voor weergave. */
export function microsToEuro(micros: number | bigint | string): number {
  return Number(micros) / 1_000_000;
}
