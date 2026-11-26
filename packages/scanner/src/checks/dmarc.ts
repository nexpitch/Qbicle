import type { Check, FindingDraft } from '../types.ts';

export function parseDmarc(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part.slice(i + 1).trim();
    if (k && !(k in tags)) tags[k] = v;
  }
  return tags;
}

export const dmarcCheck: Check = {
  key: 'mail.dmarc',
  level: 0,
  group: 'e-mail',
  appliesTo: 'domein',
  title: 'DMARC: wat ontvangers met nepmail uit jouw naam doen',
  async run({ domain, net }) {
    const name = `_dmarc.${domain}`;
    const records = (await net.resolveTxt(name)).filter((t) => /^v=dmarc1(\s*;|\s*$)/i.test(t.trim()));
    const evidence: Record<string, unknown> = { name, records };
    const findings: FindingDraft[] = [];

    if (records.length === 0) {
      // Bij twijfel (MX-opvraging mislukt) gaan we ervan uit dat het domein wel mailt.
      const mx = await net.resolveMx(domain).catch(() => null);
      const noMail = mx !== null && mx.length === 0;
      evidence.mx = mx?.map((m) => m.exchange) ?? null;
      findings.push({
        key: noMail ? 'dmarc.missing_no_mail' : 'dmarc.missing',
        certainty: 'vastgesteld',
        title: 'DMARC staat niet aan',
        detail: noMail
          ? `Er is geen DMARC-record op ${name}. ${domain} ontvangt geen mail, maar kan wel als afzender van nepmail worden misbruikt. Met "v=DMARC1; p=reject" weigeren ontvangers zulke mail.`
          : `Er is geen DMARC-record op ${name}. Ontvangers weten dan niet wat ze moeten doen met mail die zich voordoet als ${domain}.`,
      });
      return { outcome: 'finding', findings, evidence };
    }
    if (records.length > 1) {
      findings.push({
        key: 'dmarc.multiple',
        certainty: 'vastgesteld',
        title: 'Er staan meerdere DMARC-records, daardoor werkt DMARC niet',
        detail: `We vonden ${records.length} DMARC-records op ${name}. Er mag er maar één zijn; ontvangers negeren ze nu.`,
      });
      return { outcome: 'finding', findings, evidence };
    }

    const tags = parseDmarc(records[0]!);
    evidence.tags = tags;
    const p = tags.p?.toLowerCase();
    if (!p || !['none', 'quarantine', 'reject'].includes(p)) {
      findings.push({
        key: 'dmarc.syntax',
        certainty: 'vastgesteld',
        title: 'Het DMARC-record bevat geen geldig beleid',
        detail: `Het record mist een geldige "p="-waarde (none, quarantine of reject), waardoor ontvangers het negeren.`,
      });
      return { outcome: 'finding', findings, evidence };
    }

    if (p === 'none') {
      findings.push({
        key: 'dmarc.p_none',
        certainty: 'vastgesteld',
        title: 'DMARC staat alleen op meekijken',
        detail: 'Het beleid is "p=none": ontvangers rapporteren nepmail, maar leveren die nog gewoon af.',
      });
    } else {
      const pct = tags.pct !== undefined ? Number(tags.pct) : 100;
      if (Number.isFinite(pct) && pct < 100) {
        findings.push({
          key: 'dmarc.partial',
          certainty: 'vastgesteld',
          title: 'DMARC geldt maar voor een deel van de mail',
          detail: `Het beleid "${p}" geldt voor ${pct}% van de mail ("pct=${tags.pct}"). De rest wordt nog gewoon afgeleverd.`,
        });
      }
      const sp = tags.sp?.toLowerCase();
      if (sp === 'none') {
        findings.push({
          key: 'dmarc.sp_none',
          certainty: 'vastgesteld',
          title: 'Subdomeinen zijn niet beschermd door DMARC',
          detail: 'Het hoofddomein is beschermd, maar voor subdomeinen staat het beleid op "sp=none".',
        });
      }
    }

    if (!tags.rua) {
      findings.push({
        key: 'dmarc.no_rua',
        certainty: 'vastgesteld',
        title: 'Je krijgt geen DMARC-rapporten',
        detail: 'Er is geen rapportage-adres ("rua=") ingesteld, dus je ziet niet wie er namens jou mailt.',
      });
    }

    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence };
  },
};
