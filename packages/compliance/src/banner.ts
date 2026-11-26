/**
 * Zoekt de cookiebanner en zijn knoppen in de pagina.
 *
 * Deze functie draait IN de browser (via page.evaluate) en mag daarom niets
 * importeren. Ze markeert gevonden knoppen met een data-attribuut, zodat de
 * browserkant er daarna gewoon op kan klikken zoals een bezoeker.
 *
 * Volgorde: eerst bekende cookieplatforms op hun vaste knop-id's, dan een
 * algemene zoektocht op zichtbare knoppen met teksten als "Accepteren" of
 * "Weigeren". Alleen de eerste laag telt: een weigerknop die pas onder
 * "Instellingen" zit, rekenen we niet als gevonden.
 */
export const MARK_ATTR = 'data-qbicle-knop';

export interface InPageBannerResult {
  platform?: 'cookiebot' | 'onetrust' | 'cookieyes' | 'complianz' | 'algemeen';
  acceptText?: string;
  rejectText?: string;
}

/**
 * Het script als tekst, zodat bundlers er geen hulpfuncties in stoppen die in de
 * browser niet bestaan. Aanroepen met page.evaluate(`(${DETECT_BANNER_JS})(attr)`).
 */
export const DETECT_BANNER_JS = String.raw`(markAttr) => {
  const PLATFORMS = [
    {
      id: 'cookiebot',
      accept: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept'],
      reject: ['#CybotCookiebotDialogBodyButtonDecline'],
    },
    { id: 'onetrust', accept: ['#onetrust-accept-btn-handler'], reject: ['#onetrust-reject-all-handler'] },
    { id: 'cookieyes', accept: ['.cky-btn-accept'], reject: ['.cky-btn-reject'] },
    { id: 'complianz', accept: ['.cmplz-btn.cmplz-accept'], reject: ['.cmplz-btn.cmplz-deny'] },
  ];

  const ACCEPT = /^(alles |alle cookies |cookies )?(accepteren|accepteer|akkoord|toestaan|ik ga akkoord|ja,? (ik ga akkoord|prima)|accept( all( cookies)?)?|allow( all)?|agree|i agree|ok(é|e)?)( alles| alle cookies)?[.!]?$/i;
  const REJECT = /^(alles |alle cookies |cookies )?(weigeren|weiger|afwijzen|niet akkoord|nee,? bedankt|alleen (noodzakelijke?|functionele?|essenti[eë]le?)( cookies)?|reject( all)?|decline( all)?|deny|only (necessary|essential)( cookies)?|necessary only)( alles| alle cookies)?[.!]?$/i;

  const visible = (el) => {
    const h = el;
    const r = h.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(h);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const text = (el) =>
    ((el).innerText || el.getAttribute('aria-label') || el.value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const mark = (el, which) => el.setAttribute(markAttr, which);

  for (const p of PLATFORMS) {
    const acc = p.accept.map((s) => document.querySelector(s)).find((e) => e && visible(e));
    const rej = p.reject.map((s) => document.querySelector(s)).find((e) => e && visible(e));
    if (acc || rej) {
      if (acc) mark(acc, 'accept');
      if (rej) mark(rej, 'reject');
      return { platform: p.id, acceptText: acc ? text(acc) : undefined, rejectText: rej ? text(rej) : undefined };
    }
  }

  const candidates = Array.from(
    document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'),
  ).filter(visible);
  const acc = candidates.find((e) => ACCEPT.test(text(e)));
  const rej = candidates.find((e) => REJECT.test(text(e)));
  if (!acc && !rej) return {};
  if (acc) mark(acc, 'accept');
  if (rej) mark(rej, 'reject');
  return { platform: 'algemeen', acceptText: acc ? text(acc) : undefined, rejectText: rej ? text(rej) : undefined };
}`;
