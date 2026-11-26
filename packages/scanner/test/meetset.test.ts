import { describe, expect, it } from 'vitest';
import { runScenario } from '../meetset/meet.ts';
import { SCENARIOS } from '../meetset/scenarios.ts';

/** De vaste meetset is een kwaliteitsdrempel: elk scenario moet de verwachte uitkomst geven. */
describe('meetset', () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: ${s.waarom}`, async () => {
      const r = await runScenario(s);
      expect({ band: r.bandGoed ? 'goed' : r.band, gemist: r.gemist, vals: r.vals, overig: r.overig }).toEqual({
        band: 'goed',
        gemist: [],
        vals: [],
        overig: [],
      });
    });
  }
});
