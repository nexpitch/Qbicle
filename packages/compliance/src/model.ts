import { fingerprint } from '@qbicle/scanner';
import type { Asset, Finding } from '@qbicle/score';
import type { ActionDef, WeightDef } from '@qbicle/score';
import type { ComplianceCheckResult } from './evaluate.ts';

/**
 * Voorstel voor gewichten en acties in het scoremodel. Staat bewust nog NIET in
 * packages/score: eerst kiezen of naleving meetelt in de urgentiescore of een
 * eigen nalevingsoverzicht krijgt (zie ontwerp, open keuzes). Alle gewichten zijn voorlopig.
 */
export const PROPOSED_ACTIONS: Record<string, ActionDef> = {
  'cookiebanner-repareren': {
    title: 'Laat je cookiebanner zo instellen dat er pas na akkoord wordt gevolgd',
    why: 'Je website plaatst trackers voordat bezoekers toestemming geven, of ook als ze weigeren. Daar controleert de Autoriteit Persoonsgegevens actief op.',
    forWho: 'webbouwer',
  },
  'weigerknop-toevoegen': {
    title: 'Zet een duidelijke knop "Weigeren" naast "Accepteren" in je cookiebanner',
    why: 'Bezoekers moeten even makkelijk kunnen weigeren als accepteren.',
    forWho: 'webbouwer',
  },
  'cookiebanner-plaatsen': {
    title: 'Vraag bezoekers toestemming voordat je ze volgt',
    why: 'Je website gebruikt tracking waarvoor toestemming nodig is, maar we vonden geen cookiebanner.',
    forWho: 'webbouwer',
  },
};

export const PROPOSED_WEIGHTS: Record<string, WeightDef> = {
  'consent.tracking_before_consent': { b: 15, action: 'cookiebanner-repareren', voorlopig: true },
  'consent.tracking_after_reject': { b: 20, action: 'cookiebanner-repareren', voorlopig: true },
  'consent.banner_missing': { b: 15, action: 'cookiebanner-plaatsen', voorlopig: true },
  'consent.no_reject_first_layer': { b: 8, action: 'weigerknop-toevoegen', voorlopig: true },
};

/** Zet de uitkomst om naar bevindingen in het bestaande model, op het asset "website". */
export function toFindings(checks: ComplianceCheckResult[], asset: Asset): Finding[] {
  return checks.flatMap((c) =>
    c.findings.map(({ discriminator, ...f }) => ({
      ...f,
      checkKey: c.checkKey,
      asset,
      fingerprint: fingerprint(asset.type, asset.value, f.key, discriminator),
    })),
  );
}
