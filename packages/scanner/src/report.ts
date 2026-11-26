import type { ScanReport } from './scan.ts';

const OUTCOME_NL = {
  ok: 'In orde',
  finding: 'Aandacht nodig',
  unknown: 'Onbekend',
  error: 'Niet gelukt',
  not_applicable: 'Niet van toepassing',
} as const;

const CERTAINTY_NL = {
  vastgesteld: 'Technisch vastgesteld',
  mogelijk: 'Mogelijk risico',
  onbekend: 'Onbekend',
  opgegeven: 'Door jou opgegeven',
} as const;

const FOR_WHO_NL = { zelf: 'Zelf', 'it-partner': 'IT-partner', webbouwer: 'Webbouwer' } as const;

/** Korte samenvatting in gewone taal voor de opdrachtregel. */
export function formatReport(r: ScanReport): string {
  const s = r.score;
  const lines: string[] = [];
  lines.push(`Qbicle Light scan van ${r.domain}`);
  lines.push(`Scanner ${r.scannerVersion} · scoremodel ${s.modelVersion} · ${new Date(r.finishedAt).toLocaleString('nl-NL')}`);
  lines.push('');
  lines.push(`Urgentie: ${s.urgency}/100 (${s.band.label})`);
  lines.push(`Dekking: ${s.coverage.pct}% (${s.coverage.done} van ${s.coverage.applicable} controles afgerond)`);
  if (s.coverageWarning) lines.push(s.coverageWarning);
  lines.push('');
  if (s.topActions.length === 0) {
    lines.push('Geen acties nodig op basis van wat we konden controleren.');
  } else {
    lines.push(`Belangrijkste acties (${s.topActions.length} van ${s.actionCount}):`);
    s.topActions.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.title}  [${FOR_WHO_NL[a.forWho]}]`);
      lines.push(`   ${a.why}`);
    });
  }
  lines.push('');
  lines.push('Alle controles:');
  for (const c of r.checks) {
    const where = c.asset.type === 'website' ? ` (${new URL(c.asset.value).hostname})` : '';
    lines.push(`- ${OUTCOME_NL[c.outcome].padEnd(19)} ${c.title}${where}`);
    for (const f of c.findings) {
      lines.push(`    · ${f.title} [${CERTAINTY_NL[f.certainty]}]`);
      if (f.vulns?.length) lines.push(`      ${f.detail}`);
      for (const src of f.sources ?? []) lines.push(`      Bron: ${src.name} ${src.url}`);
    }
    if (c.message && c.outcome !== 'finding') lines.push(`    ${c.message}`);
  }
  return lines.join('\n');
}
