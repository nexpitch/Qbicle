import type { Net } from '../net.ts';
import type { Check, FindingDraft } from '../types.ts';
import { mailProfile, mailTarget, measuredOnNote } from './maildomain.ts';

const LOOKUP_LIMIT = 10;
const MECHANISMS = new Set(['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists']);
const MODIFIERS = new Set(['redirect', 'exp']);
const LOOKUP_TERMS = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);

export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

export interface ParsedSpf {
  terms: { qualifier: string; name: string; value: string | null; raw: string }[];
  syntaxErrors: string[];
}

export function parseSpf(record: string): ParsedSpf {
  const parts = record.trim().split(/\s+/).slice(1);
  const terms: ParsedSpf['terms'] = [];
  const syntaxErrors: string[] = [];
  for (const raw of parts) {
    const m = raw.match(/^([+?~-]?)([a-z][a-z0-9_.-]*)(?:([:=/])(.*))?$/i);
    if (!m) {
      syntaxErrors.push(raw);
      continue;
    }
    const qualifier = m[1] || '+';
    const name = m[2]!.toLowerCase();
    const sep = m[3];
    const value = m[4] ?? null;
    if (sep === '=') {
      if (!MODIFIERS.has(name)) {
        // Onbekende modifiers moeten volgens RFC 7208 genegeerd worden.
        continue;
      }
      if (m[1]) syntaxErrors.push(raw);
    } else if (!MECHANISMS.has(name)) {
      syntaxErrors.push(raw);
      continue;
    } else if ((name === 'include' || name === 'exists') && !value) {
      syntaxErrors.push(raw);
      continue;
    }
    terms.push({ qualifier, name, value, raw });
  }
  return { terms, syntaxErrors };
}

interface LookupResult {
  count: number;
  broken: string[];
}

/**
 * Telt DNS-lookups volgens RFC 7208 §4.6.4, inclusief geneste includes. Elke
 * verwijzing telt, ook als dezelfde include twee keer voorkomt; alleen een lus
 * (een include die naar zichzelf terugwijst) volgen we niet opnieuw.
 */
async function countLookups(net: Net, domain: string, depth: number, path: Set<string>): Promise<LookupResult> {
  const result: LookupResult = { count: 0, broken: [] };
  if (depth > LOOKUP_LIMIT || path.has(domain)) return result;
  const txt = (await net.resolveTxt(domain)).filter(isSpfRecord);
  if (txt.length !== 1) {
    result.broken.push(domain);
    return result;
  }
  const inner = new Set(path).add(domain);
  const { terms } = parseSpf(txt[0]!);
  for (const t of terms) {
    if (!LOOKUP_TERMS.has(t.name)) continue;
    result.count += 1;
    if ((t.name === 'include' || t.name === 'redirect') && t.value && !t.value.includes('%')) {
      const sub = await countLookups(net, t.value.toLowerCase(), depth + 1, inner);
      result.count += sub.count;
      result.broken.push(...sub.broken);
    }
    if (result.count > LOOKUP_LIMIT) break;
  }
  return result;
}

export const spfCheck: Check = {
  key: 'mail.spf',
  level: 0,
  group: 'e-mail',
  appliesTo: 'domein',
  title: 'SPF: wie mag mailen namens dit domein',
  async run(ctx) {
    const { net } = ctx;
    const target = await mailTarget(ctx);
    const domain = target.name;
    const note = measuredOnNote(ctx.domain, target);
    const txt = await net.resolveTxt(domain);
    const records = txt.filter(isSpfRecord);
    const profile = await mailProfile(net, domain, ctx.memo);
    const evidence: Record<string, unknown> = { measuredOn: domain, records, mx: profile.mx, nullMx: profile.nullMx };
    const findings: FindingDraft[] = [];

    if (records.length === 0) {
      findings.push({
        // Alleen als zeker is dat er niet gemaild wordt, is het advies "dichtzetten".
        key: profile.noMail ? 'spf.missing_no_mail' : 'spf.missing',
        certainty: 'vastgesteld',
        title: 'Er is niet vastgelegd wie namens dit domein mag mailen',
        detail: profile.noMail
          ? `${domain} heeft geen SPF-record en we zien geen tekenen dat er vanaf gemaild wordt. Verstuur je vanaf dit domein echt geen mail (ook geen nieuwsbrief, webshop- of factuurmail)? Dan helpt "v=spf1 -all" tegen nepmail uit jouw naam. Mail je er wel mee, zet dan de servers die namens jou mailen in het SPF-record.${note}`
          : `${domain} heeft geen SPF-record. Ontvangers kunnen nepmail uit jouw naam dan moeilijker herkennen. Zet in het record alle diensten die namens jou mailen (je mailprovider, nieuwsbrief, webshop).${note}`,
      });
      return { outcome: 'finding', findings, evidence };
    }
    if (records.length > 1) {
      findings.push({
        key: 'spf.multiple',
        certainty: 'vastgesteld',
        title: 'Er staan meerdere SPF-records, daardoor werkt SPF niet',
        detail: `We vonden ${records.length} SPF-records. Volgens de standaard moet er precies één zijn; ontvangers negeren ze nu.`,
      });
      return { outcome: 'finding', findings, evidence };
    }

    const record = records[0]!;
    const parsed = parseSpf(record);
    if (parsed.syntaxErrors.length > 0) {
      findings.push({
        key: 'spf.syntax',
        certainty: 'vastgesteld',
        title: 'Het SPF-record bevat een fout',
        detail: `Deze onderdelen kloppen niet: ${parsed.syntaxErrors.join(', ')}. Ontvangers kunnen het hele record dan negeren.`,
      });
    }

    const all = parsed.terms.find((t) => t.name === 'all');
    const redirect = parsed.terms.find((t) => t.name === 'redirect');
    if (all?.qualifier === '+') {
      findings.push({
        key: 'spf.plus_all',
        certainty: 'vastgesteld',
        title: 'Het SPF-record staat iedereen toe om namens jou te mailen',
        detail: `Het record eindigt op "${all.raw}". Daarmee mag elke server ter wereld mail sturen uit naam van ${domain}.`,
      });
    } else if (all?.qualifier === '?') {
      findings.push({
        key: 'spf.neutral_all',
        certainty: 'vastgesteld',
        title: 'Het SPF-record zegt niets over onbekende afzenders',
        detail: 'Het record eindigt op "?all". Ontvangers krijgen dan geen signaal dat mail van andere servers nep is.',
      });
    } else if (!all && !redirect) {
      findings.push({
        key: 'spf.no_all',
        certainty: 'mogelijk',
        title: 'Het SPF-record heeft geen afsluitende regel',
        detail: 'Het record eindigt niet op "-all" of "~all", waardoor niet duidelijk is wat er met andere afzenders moet gebeuren.',
      });
    }

    const lookups = await countLookups(net, domain, 0, new Set());
    evidence.lookups = lookups.count;
    if (lookups.broken.filter((d) => d !== domain).length > 0) {
      findings.push({
        key: 'spf.include_broken',
        certainty: 'vastgesteld',
        title: 'Het SPF-record verwijst naar iets dat niet bestaat',
        detail: `Deze verwijzingen geven geen geldig SPF-record: ${lookups.broken.filter((d) => d !== domain).join(', ')}.`,
      });
    }
    if (lookups.count > LOOKUP_LIMIT) {
      findings.push({
        key: 'spf.too_many_lookups',
        certainty: 'vastgesteld',
        title: 'Het SPF-record is te ingewikkeld en wordt daardoor afgekeurd',
        detail: `Het record heeft meer dan ${LOOKUP_LIMIT} DNS-opvragingen nodig (wij telden er minstens ${lookups.count}). Ontvangers stoppen dan met controleren.`,
      });
    }

    return { outcome: findings.length ? 'finding' : 'ok', findings, evidence, message: note.trim() || undefined };
  },
};
