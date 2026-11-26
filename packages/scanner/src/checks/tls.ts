import type { TlsInfo } from '../net.ts';
import type { Check, CheckContext, FindingDraft } from '../types.ts';
import { hostOf } from './web.ts';

const DAY = 24 * 60 * 60 * 1000;

const CHAIN_ERRORS = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const SELF_SIGNED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT']);
/** Keten eindigt bij een root die browsers niet kennen. */
const UNTRUSTED_CA = new Set(['SELF_SIGNED_CERT_IN_CHAIN']);
/**
 * Certificaten met een korte looptijd (zoals Let's Encrypt, 90 dagen) worden
 * standaard pas 30 dagen voor afloop vernieuwd; dan is "binnen een maand" normaal.
 */
const SHORT_LIVED_DAYS = 100;

export function getTls(ctx: CheckContext, host: string): Promise<TlsInfo> {
  return ctx.memo(`tls:${host}`, () => ctx.net.tlsHandshake(host, 443));
}

export const certificateCheck: Check = {
  key: 'tls.certificate',
  level: 1,
  group: 'certificaat',
  appliesTo: 'website',
  title: 'Certificaat van de website',
  async run(ctx) {
    const host = hostOf(ctx.asset);
    let info: TlsInfo;
    try {
      info = await getTls(ctx, host);
    } catch (e) {
      return {
        outcome: 'unknown',
        evidence: { error: (e as { code?: string }).code ?? String(e) },
        message: `We konden geen beveiligde verbinding met ${host} maken, dus het certificaat is niet gecontroleerd.`,
      };
    }
    const evidence: Record<string, unknown> = { ...info };
    if (!info.cert) {
      return { outcome: 'unknown', evidence, message: `${host} stuurde geen certificaat mee.` };
    }

    const findings: FindingDraft[] = [];
    const validTo = new Date(info.cert.validTo);
    const daysLeft = Math.floor((validTo.getTime() - ctx.now.getTime()) / DAY);
    evidence.daysLeft = daysLeft;
    const err = info.authorizationError;
    const dateNl = validTo.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });

    if (err === 'CERT_HAS_EXPIRED' || daysLeft < 0) {
      findings.push({
        key: 'cert.expired',
        certainty: 'vastgesteld',
        title: 'Het certificaat van de website is verlopen',
        detail: `Het certificaat van ${host} is verlopen op ${dateNl}. Bezoekers krijgen een waarschuwing in hun browser.`,
      });
    } else if (err && CHAIN_ERRORS.has(err)) {
      findings.push({
        key: 'cert.chain_incomplete',
        certainty: 'vastgesteld',
        title: 'Het certificaat mist een tussenstap',
        detail: `De server van ${host} stuurt de certificaatketen niet compleet mee (${err}). Sommige browsers en apps weigeren de verbinding.`,
      });
    } else if (err && SELF_SIGNED.has(err)) {
      findings.push({
        key: 'cert.self_signed',
        certainty: 'vastgesteld',
        title: 'Het certificaat is niet door een erkende partij uitgegeven',
        detail: `${host} gebruikt een zelfgemaakt certificaat. Browsers vertrouwen dat niet.`,
      });
    } else if (err && UNTRUSTED_CA.has(err)) {
      findings.push({
        key: 'cert.untrusted_ca',
        certainty: 'vastgesteld',
        title: 'Het certificaat komt van een partij die browsers niet vertrouwen',
        detail: `Het certificaat van ${host} is uitgegeven door ${info.cert.issuer ?? 'een onbekende partij'}, die niet in de lijst van erkende uitgevers staat.`,
      });
    } else if (err) {
      findings.push({
        key: 'cert.invalid',
        certainty: 'vastgesteld',
        title: 'Het certificaat van de website is ongeldig',
        detail: `Browsers keuren het certificaat van ${host} af (${err}).`,
      });
    }

    if (!info.nameMatches) {
      findings.push({
        key: 'cert.name_mismatch',
        certainty: 'vastgesteld',
        title: 'Het certificaat hoort bij een andere naam',
        detail: `Het certificaat geldt voor ${info.cert.altNames.slice(0, 5).join(', ') || info.cert.subjectCn || 'een andere naam'}, niet voor ${host}.`,
      });
    }

    const lifetimeDays = Math.floor((validTo.getTime() - new Date(info.cert.validFrom).getTime()) / DAY);
    evidence.lifetimeDays = lifetimeDays;
    const shortLived = lifetimeDays <= SHORT_LIVED_DAYS;
    if (daysLeft >= 0 && err !== 'CERT_HAS_EXPIRED') {
      if (daysLeft <= (shortLived ? 7 : 14)) {
        findings.push({
          key: 'cert.expires_14d',
          certainty: 'vastgesteld',
          title: shortLived ? 'Het certificaat verloopt binnen een week' : 'Het certificaat verloopt binnen twee weken',
          detail: `Het certificaat van ${host} verloopt op ${dateNl}, over ${daysLeft} dagen.`,
        });
      } else if (!shortLived && daysLeft <= 30) {
        findings.push({
          key: 'cert.expires_30d',
          certainty: 'vastgesteld',
          title: 'Het certificaat verloopt binnen een maand',
          detail: `Het certificaat van ${host} verloopt op ${dateNl}, over ${daysLeft} dagen. Controleer of het automatisch wordt verlengd.`,
        });
      }
    }

    return {
      outcome: findings.length ? 'finding' : 'ok',
      findings,
      evidence,
      message: findings.length ? undefined : `Geldig tot ${dateNl}, uitgegeven door ${info.cert.issuer ?? 'onbekend'}.`,
    };
  },
};
