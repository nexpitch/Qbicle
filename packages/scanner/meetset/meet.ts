import { fileURLToPath } from 'node:url';
import { scanDomain } from '../src/scan.ts';
import { NOW } from '../test/helpers.ts';
import { SCENARIOS, type Scenario } from './scenarios.ts';

// De meetset rekent met een vaste datum (NOW) en dus ook met een vaste kennis-snapshot.
process.env.QBICLE_EOL_FILE ??= fileURLToPath(new URL('../test/fixtures/eol-snapshot.json', import.meta.url));

export interface ScenarioResult {
  id: string;
  waarom: string;
  urgentie: number | null;
  band: string | null;
  bandGoed: boolean;
  /** Verwachte bevindingen die ontbraken (of met de verkeerde zekerheid). */
  gemist: string[];
  /** Bevindingen die er niet hadden mogen zijn. */
  vals: string[];
  /** Overige afwijkingen: dekkingswaarschuwing, uitkomst, assets, fouten. */
  overig: string[];
  verwachtAantal: number;
  goed: boolean;
}

export interface Summary {
  scenarios: number;
  helemaalGoed: number;
  bandGoed: number;
  verwachteBevindingen: number;
  gevonden: number;
  gemist: number;
  vals: number;
  overig: number;
}

export async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const v = s.verwacht;
  const moet = (v.moet ?? []).map((m) => (typeof m === 'string' ? { key: m, zekerheid: undefined } : m));
  const base = { id: s.id, waarom: s.waarom, verwachtAantal: moet.length };
  let r;
  try {
    r = await scanDomain(s.domein, { net: s.net(), now: NOW });
  } catch (e) {
    return { ...base, urgentie: null, band: null, bandGoed: false, gemist: moet.map((m) => m.key), vals: [], overig: [`fout: ${(e as Error).message}`], goed: false };
  }
  const found = r.findings;
  const gemist = moet
    .filter((m) => !found.some((f) => f.key === m.key && (!m.zekerheid || f.certainty === m.zekerheid)))
    .map((m) => {
      const other = found.find((f) => f.key === m.key);
      return other ? `${m.key} (zekerheid ${other.certainty}, verwacht ${m.zekerheid})` : m.key;
    });
  const moetKeys = new Set(moet.map((m) => m.key));
  const vals = [
    ...new Set(
      found
        .filter((f) => (v.magNiet ?? []).includes(f.key) || (v.verderSchoon && !moetKeys.has(f.key)))
        .map((f) => f.key),
    ),
  ];
  const overig: string[] = [];
  const warn = (r.score as { coverageWarning?: string | null }).coverageWarning ?? null;
  if (v.dekkingWaarschuwing === true && !warn) overig.push(`geen dekkingswaarschuwing bij ${r.score.coverage.pct}% dekking`);
  if (v.dekkingWaarschuwing === false && warn) overig.push('onterechte dekkingswaarschuwing');
  for (const [check, want] of Object.entries(v.uitkomst ?? {})) {
    const got = r.checks.find((c) => c.checkKey === check)?.outcome;
    if (got !== want) overig.push(`${check}: ${got ?? 'ontbreekt'} in plaats van ${want}`);
  }
  if (v.maxUrgentie !== undefined && r.score.urgency > v.maxUrgentie) overig.push(`urgentie ${r.score.urgency} boven ${v.maxUrgentie}`);
  for (const a of v.assetsNiet ?? []) if (r.assets.some((x) => x.value === a)) overig.push(`onterecht gescand: ${a}`);
  const bandGoed = v.band.includes(r.score.band.key as never);
  return {
    ...base,
    urgentie: r.score.urgency,
    band: r.score.band.label,
    bandGoed,
    gemist,
    vals,
    overig,
    goed: bandGoed && gemist.length === 0 && vals.length === 0 && overig.length === 0,
  };
}

export async function runMeetset(scenarios = SCENARIOS): Promise<{ results: ScenarioResult[]; summary: Summary }> {
  const results: ScenarioResult[] = [];
  for (const s of scenarios) results.push(await runScenario(s));
  const verwacht = results.reduce((n, r) => n + r.verwachtAantal, 0);
  const gemist = results.reduce((n, r) => n + r.gemist.length, 0);
  return {
    results,
    summary: {
      scenarios: results.length,
      helemaalGoed: results.filter((r) => r.goed).length,
      bandGoed: results.filter((r) => r.bandGoed).length,
      verwachteBevindingen: verwacht,
      gevonden: verwacht - gemist,
      gemist,
      vals: results.reduce((n, r) => n + r.vals.length, 0),
      overig: results.reduce((n, r) => n + r.overig.length, 0),
    },
  };
}
