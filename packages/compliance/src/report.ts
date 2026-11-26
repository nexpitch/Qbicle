import type { ConsentEvaluation } from './evaluate.ts';
import type { ConsentObservations } from './types.ts';

const LABEL = { ok: 'In orde', finding: 'Aandacht nodig', unknown: 'Onbekend', error: 'Fout', not_applicable: 'Niet van toepassing' } as const;
const ZEKER = { vastgesteld: 'Technisch vastgesteld', mogelijk: 'Mogelijk risico', onbekend: 'Onbekend', opgegeven: 'Door jou opgegeven' } as const;

/** Samenvatting in gewone taal voor de opdrachtregel. */
export function formatConsentReport(obs: ConsentObservations, ev: ConsentEvaluation): string {
  const lines: string[] = [];
  const b = obs.visits['geen-keuze'].banner;
  lines.push(`Cookiecheck ${obs.url}`);
  lines.push(
    b.found
      ? `Cookiebanner: gevonden (${b.platform}); akkoord: ${b.acceptText ?? 'niet gevonden'}; weigeren: ${b.rejectText ?? 'niet gevonden'}`
      : 'Cookiebanner: niet gevonden',
  );
  lines.push('');
  for (const c of ev.checks) {
    lines.push(`[${LABEL[c.outcome]}] ${c.title}`);
    if (c.message) lines.push(`    ${c.message}`);
    for (const f of c.findings) lines.push(`    - ${f.title} (${ZEKER[f.certainty]})`, `      ${f.detail}`);
  }
  lines.push('');
  for (const [s, list] of Object.entries(ev.seen)) {
    lines.push(`Trackers bij "${s}": ${list.length ? list.map((t) => t.name).join(', ') : 'geen'}`);
  }
  if (ev.unknownThirdPartyCookies.length) lines.push(`Onbekende cookies van derden: ${ev.unknownThirdPartyCookies.join(', ')}`);
  if (ev.measurementNote) lines.push(`Let op: ${ev.measurementNote}`);
  lines.push('', 'Dit is een technische waarneming, geen juridisch oordeel.');
  return lines.join('\n');
}
