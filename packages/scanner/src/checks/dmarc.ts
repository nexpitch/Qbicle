import type { Check, FindingDraft } from '../types.ts';
import { mailProfile, mailTarget, measuredOnNote } from './maildomain.ts';

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

async function dmarcRecords(ctx: { net: import('../net.ts').Net }, name: string): Promise<string[]> {
  return (await ctx.net.resolveTxt(`_dmarc.${name}`)).filter((t) => /^v=dmarc1(\s*;|\s*$)/i.test(t.trim()));
}

export const dmarcCheck: Check = {
  key: 'mail.dmarc',
  level: 0,
  group: 'e-mail',
  appliesTo: 'domein',
  title: 'DMARC: wat ontvangers met nepmail uit jouw naam doen',
  async run(ctx) {
    const target = await mailTarget(ctx);
    const own = `_dmarc.${target.name}`;
    // RFC 7489 §6.6.3: eerst op de naam zelf, anders op het hoofddomein (met het sp-beleid).
    // Een subdomein met een eigen record (ook naast een CNAME) gebruikt dat eigen record.
    const candidates = [...new Set([ctx.domain, target.name, target.orgDomain])];
    let records: string[] = [];
    let name = own;
    let foundOn = target.name;
    for (const c of candidates) {
      const r = await dmarcRecords(ctx, c);
      if (r.length > 0) {
        records = r;
        name = `_dmarc.${c}`;
        foundOn = c;
        break;
      }
    }
    const inherited = records.length > 0 && foundOn === target.orgDomain && ctx.domain !== target.orgDomain;
    const domain = foundOn;
    const note = measuredOnNote(ctx.domain, target);
    const evidence: Record<string, unknown> = { measuredOn: target.name, name, records, inherited };
    const findings: FindingDraft[] = [];

    if (records.length === 0) {
      const profile = await mailProfile(ctx.net, target.name, ctx.memo);
      evidence.mx = profile.mx;
      evidence.nullMx = profile.nullMx;
      const where = target.name !== target.orgDomain ? `_dmarc.${target.name} en _dmarc.${target.orgDomain}` : own;
      findings.push({
        key: profile.noMail ? 'dmarc.missing_no_mail' : 'dmarc.missing',
        certainty: 'vastgesteld',
        title: 'DMARC staat niet aan',
        detail: profile.noMail
          ? `Er is geen DMARC-record op ${where}, en we zien geen tekenen dat er vanaf ${target.name} gemaild wordt. Verstuur je vanaf dit domein echt geen mail? Dan laat "v=DMARC1; p=reject" ontvangers nepmail uit jouw naam weigeren. Twijfel je, begin dan met "p=none" en een rapportage-adres.${note}`
          : `Er is geen DMARC-record op ${where}. Ontvangers weten dan niet wat ze moeten doen met mail die zich voordoet als ${target.name}. ` +
            `Begin veilig met "v=DMARC1; p=none; rua=mailto:" plus een eigen adres: dan verandert er nog niets aan je mail, maar zie je wie er namens jou mailt. Zet het na een paar weken rapporten stap voor stap op "quarantine" en daarna "reject".${note}`,
      });
      return { outcome: 'finding', findings, evidence };
    }
    if (records.length > 1) {
      findings.push({
        key: 'dmarc.multiple',
        certainty: 'vastgesteld',
        title: 'Er staan meerdere DMARC-records, daardoor werkt DMARC niet',
        detail: `We vonden ${records.length} DMARC-records op ${name}. Er mag er maar één zijn; ontvangers negeren ze nu.${note}`,
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
        detail: `Het record op ${name} mist een geldige "p="-waarde (none, quarantine of reject), waardoor ontvangers het negeren.${note}`,
      });
      return { outcome: 'finding', findings, evidence };
    }

    const sp = tags.sp?.toLowerCase();
    if (inherited) {
      // Het subdomein valt onder het beleid voor subdomeinen van het hoofddomein.
      const effective = sp && ['none', 'quarantine', 'reject'].includes(sp) ? sp : p;
      evidence.effectivePolicy = effective;
      if (effective === 'none') {
        findings.push(
          p !== 'none'
            ? {
                key: 'dmarc.sp_none',
                certainty: 'vastgesteld',
                title: 'Subdomeinen zijn niet beschermd door DMARC',
                detail: `${domain} is beschermd, maar voor subdomeinen zoals ${target.name} staat het beleid op "sp=none". Nepmail uit naam van ${target.name} wordt dus nog afgeleverd.${note}`,
              }
            : {
                key: 'dmarc.p_none',
                certainty: 'vastgesteld',
                title: 'DMARC staat alleen op meekijken',
                detail: `Het beleid op ${name} is "p=none": ontvangers rapporteren nepmail, maar leveren die nog gewoon af. Zet het stap voor stap strenger zodra de rapporten laten zien dat al je eigen mail goed aankomt.${note}`,
              },
        );
      }
    } else if (p === 'none') {
      findings.push({
        key: 'dmarc.p_none',
        certainty: 'vastgesteld',
        title: 'DMARC staat alleen op meekijken',
        detail: `Het beleid is "p=none": ontvangers rapporteren nepmail, maar leveren die nog gewoon af. Zet het stap voor stap strenger ("quarantine", daarna "reject") zodra de rapporten laten zien dat al je eigen mail goed aankomt.${note}`,
      });
    } else {
      const pct = tags.pct !== undefined ? Number(tags.pct) : 100;
      if (Number.isFinite(pct) && pct < 100) {
        findings.push({
          key: 'dmarc.partial',
          certainty: 'vastgesteld',
          title: 'DMARC geldt maar voor een deel van de mail',
          detail: `Het beleid "${p}" geldt voor ${pct}% van de mail ("pct=${tags.pct}"). De rest wordt nog gewoon afgeleverd.${note}`,
        });
      }
      if (sp === 'none') {
        findings.push({
          key: 'dmarc.sp_none',
          certainty: 'vastgesteld',
          title: 'Subdomeinen zijn niet beschermd door DMARC',
          detail: `Het hoofddomein is beschermd, maar voor subdomeinen staat het beleid op "sp=none".${note}`,
        });
      }
    }

    if (!tags.rua) {
      findings.push({
        key: 'dmarc.no_rua',
        certainty: 'vastgesteld',
        title: 'Je krijgt geen DMARC-rapporten',
        detail: `Er is geen rapportage-adres ("rua=") ingesteld op ${name}, dus je ziet niet wie er namens jou mailt.${note}`,
      });
    }

    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence, message: note.trim() || undefined };
  },
};
