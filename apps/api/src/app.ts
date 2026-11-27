import {
  cancelSubscription,
  checkoutSubscription,
  completeSignup,
  createAuditOrder,
  getBilling,
  getBillingDetails,
  getInvoice,
  getPayment,
  listInvoices,
  publicCatalog,
  registerSignup,
  settleTestPayment,
  startSubscription,
  syncPayment,
  updateBillingDetails,
  listContacts,
  changePlan,
  retryPayment,
  getBillingHistory,
  previewPlanChange,
  cancelScheduledChange,
  resumeSubscription,
  revokeMandate,
  requestInvoicePayment,
  removeContact,
  setContact,
  BILLING_INTERVALS,
  acceptInvitation,
  addDomain,
  authenticate,
  changeMemberRole,
  confirmEmailVerification,
  createClientForPartner,
  createOrganization,
  getDomain,
  getOrganization,
  grantPartnerAccess,
  inviteMember,
  listAudit,
  listClients,
  listDomains,
  listInvitations,
  listMembers,
  listOrganizationsForUser,
  listPartners,
  login,
  logout,
  logoutEverywhere,
  authorize,
  one,
  addSysteem,
  listSystemen,
  removeSysteem,
  updateSysteem,
  JA_NEE,
  SYSTEEM_DATALOCATIE,
  SYSTEEM_GEGEVENS,
  SYSTEEM_HOSTING,
  SYSTEEM_IMPACT,
  SYSTEEM_INLOGGEN,
  SYSTEEM_SOORTEN,
  SYSTEEM_TERUGVAL,
  SYSTEEM_UPDATES,
  ORG_KINDS,
  PARTNER_ACCESS,
  PlatformError,
  removeDomain,
  removeMember,
  renameOrganization,
  requestLoginLink,
  requestScan,
  getScan,
  revokeInvitation,
  revokePartnerAccess,
  ROLES,
  startEmailVerification,
  verifyDomainByDns,
  type Actor,
  type Platform,
  type Session,
} from '@qbicle/platform';
import { addDomains, demoDataAllowed, findDnsHost, getAssetDetail, getDashboard, seedDemoData } from '@qbicle/platform';
import { recordUsage } from '@qbicle/ops';
import { KoppelingFout, KOPPELINGEN, teststandVoor } from '@qbicle/koppelingen';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';

/**
 * Basis-API van Qbicle (JSON, /api/v1). Bewust los van een webframework
 * gehouden: deze Hono-app draait los (src/server.ts) en kan later één-op-één
 * achter Next.js-routes hangen.
 *
 * Beveiliging:
 * - Sessie in een cookie: __Host-, HttpOnly, Secure, SameSite=Lax.
 * - Elke wijzigende aanvraag (POST/PATCH/DELETE) moet JSON zijn en een Origin
 *   hebben die gelijk is aan de app (bescherming tegen CSRF).
 * - Alle invoer wordt gevalideerd; fouten verklappen niets over andere organisaties.
 */

export interface ApiOptions {
  /** Cookie alleen via https (uit te zetten voor lokaal testen zonder https). */
  secureCookies: boolean;
  /** Achter een vertrouwde proxy: neem het IP uit X-Forwarded-For. */
  trustProxy: boolean;
}

type Vars = { session: Session | undefined; actor: Actor };
type Env = { Variables: Vars };

export const SESSION_COOKIE = '__Host-qbicle_sessie';
const DEV_SESSION_COOKIE = 'qbicle_sessie';

const id = z.uuid();
const email = z.string().max(254);
const role = z.enum(ROLES);

const schemas = {
  loginLink: z.object({ email }),
  token: z.object({ token: z.string().max(200) }),
  createOrg: z.object({ name: z.string().max(200), kind: z.enum(ORG_KINDS).default('klant') }),
  renameOrg: z.object({ name: z.string().max(200) }),
  changeRole: z.object({ role }),
  invite: z.object({ email, role: role.default('lezer') }),
  contact: z.object({ naam: z.string().max(200).nullish(), email: z.string().max(320).nullish(), telefoon: z.string().max(40).nullish() }),
  createClient: z.object({ name: z.string().max(200) }),
  grantPartner: z.object({ partnerOrganizationId: id, access: z.enum(PARTNER_ACCESS).default('lezer') }),
  addDomain: z.object({ name: z.string().max(300) }),
  emailVerify: z.object({ address: z.string().max(320), eigenAdres: z.string().max(320).optional() }),
  scan: z.object({ maxLevel: z.union([z.literal(0), z.literal(1)]).optional() }),
  signup: z.object({
    email,
    organisatie: z.string().max(200),
    pakket: z.string().max(40),
    interval: z.enum(BILLING_INTERVALS).default('jaar'),
  }),
  subscription: z.object({ pakket: z.string().max(40), interval: z.enum(BILLING_INTERVALS) }),
  cancel: z.object({ reden: z.string().max(40).nullish(), toelichting: z.string().max(1000).nullish() }),
  invoiceRequest: z.object({ toelichting: z.string().max(600) }),
  auditOrder: z.object({
    pakket: z.string().max(40),
    doelbedrijf: z.string().max(200),
    domeinen: z.array(z.string().max(300)).min(1).max(100),
  }),
  billingDetails: z.object({
    naam: z.string().max(200).nullish(),
    email: z.string().max(254).nullish(),
    adres: z.string().max(400).nullish(),
    postcode: z.string().max(16).nullish(),
    plaats: z.string().max(100).nullish(),
    land: z.string().max(2).nullish(),
    kvk: z.string().max(20).nullish(),
    btwNummer: z.string().max(30).nullish(),
    referentie: z.string().max(100).nullish(),
  }),
  testPayment: z.object({ uitkomst: z.enum(['betaald', 'mislukt', 'geannuleerd']) }),
  systeem: z.object({
    naam: z.string().max(120),
    leverancier: z.string().max(120).nullish(),
    soort: z.enum(SYSTEEM_SOORTEN),
    hosting: z.enum(SYSTEEM_HOSTING).optional(),
    adres: z.string().max(300).nullish(),
    eigenaar: z.string().max(120).nullish(),
    impactUitval: z.enum(SYSTEEM_IMPACT),
    gegevens: z.array(z.enum(SYSTEEM_GEGEVENS)).max(4).optional(),
    inloggen: z.enum(SYSTEEM_INLOGGEN).optional(),
    updates: z.enum(SYSTEEM_UPDATES).optional(),
    verwerkersovereenkomst: z.enum(JA_NEE).optional(),
    datalocatie: z.enum(SYSTEEM_DATALOCATIE).optional(),
    terugval: z.enum(SYSTEEM_TERUGVAL).optional(),
    notities: z.string().max(1000).nullish(),
  }),
  testKoppeling: z.object({ uitkomst: z.enum(['gelukt', 'te_veel_rechten', 'mislukt']).default('gelukt') }),
};

function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    // Alleen het laatste adres komt van onze eigen proxy; de rest stuurt de bezoeker zelf mee.
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
  }
  // @hono/node-server zet het adres van de verbinding in env.incoming.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new PlatformError('ongeldige_invoer', 'De aanvraag is geen geldige JSON.');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'invoer';
    throw new PlatformError('ongeldige_invoer', `Ongeldige waarde voor ${field}.`);
  }
  return parsed.data;
}

function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v || !id.safeParse(v).success) throw new PlatformError('niet_gevonden', 'Dit onderdeel bestaat niet of je hebt er geen toegang toe.');
  return v;
}

export function createApi(p: Platform, opts: ApiOptions): Hono<Env> {
  const app = new Hono<Env>();
  const cookieName = opts.secureCookies ? SESSION_COOKIE : DEV_SESSION_COOKIE;
  const allowedOrigin = new URL(p.config.appOrigin).origin;

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // CSRF: wijzigende aanvragen alleen als JSON en vanaf onze eigen app.
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== allowedOrigin) {
        return c.json({ fout: 'geen_toegang', bericht: 'Aanvraag van een onbekende herkomst geweigerd.' }, 403);
      }
      const ct = c.req.header('content-type') ?? '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return c.json({ fout: 'ongeldige_invoer', bericht: 'Stuur de aanvraag als application/json.' }, 415);
      }
    }
    await next();
  });

  app.use('*', async (c, next) => {
    const session = await authenticate(p, getCookie(c, cookieName));
    c.set('session', session);
    c.set('actor', {
      userId: session?.user.id ?? null,
      email: session?.user.email,
      ip: clientIp(c, opts.trustProxy),
      userAgent: c.req.header('user-agent') ?? null,
    });
    await next();
  });

  const requireUser: MiddlewareHandler<Env> = async (c, next) => {
    if (!c.get('session')) throw new PlatformError('niet_ingelogd', 'Log eerst in.');
    await next();
  };
  const user = (c: Context<Env>) => {
    const s = c.get('session')!;
    return { ...c.get('actor'), userId: s.user.id, email: s.user.email };
  };

  app.onError((err, c) => {
    if (err instanceof PlatformError) {
      return c.json({ fout: err.code, bericht: err.message }, err.status as 400);
    }
    console.error(err);
    return c.json({ fout: 'serverfout', bericht: 'Er ging iets mis. Probeer het later opnieuw.' }, 500);
  });
  app.notFound((c) => c.json({ fout: 'niet_gevonden', bericht: 'Onbekend adres.' }, 404));

  const v1 = new Hono<Env>();

  // Gebruiksmeting: geslaagde API-aanroepen per klant, per dag en per route (cockpit).
  // Alleen na een geslaagd antwoord, zodat niemand de teller van een andere klant kan ophogen.
  v1.use('/organisaties/:org/*', async (c, next) => {
    await next();
    const org = c.req.param('org');
    if (c.res.status < 400 && org && id.safeParse(org).success) {
      const feature = `${c.req.method} ${c.req.routePath.replace(/^\/api\/v1/, '')}`.slice(0, 80);
      recordUsage(p.pool, { organizationId: org, metric: 'api', feature }).catch((err) => console.error('Meting mislukt:', err));
    }
  });

  v1.get('/gezond', (c) => c.json({ ok: true }));

  // Inloggen ------------------------------------------------------------------
  v1.post('/auth/inloglink', async (c) => {
    const { email } = await body(c, schemas.loginLink);
    await requestLoginLink(p, email, c.get('actor'));
    return c.json({ bericht: 'Als dit adres bij ons bekend is of nieuw is, staat er binnen een minuut een inloglink in je mail.' }, 202);
  });

  v1.post('/auth/inloggen', async (c) => {
    const { token } = await body(c, schemas.token);
    const result = await login(p, token, c.get('actor'));
    setCookie(c, cookieName, result.sessionToken, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: 'Lax',
      path: '/',
      expires: result.session.expiresAt,
    });
    // Openstaande registratie voor dit adres? Dan nu de organisatie en de proef aanmaken.
    const u = result.session.user;
    const registratie = await completeSignup(p, { ...c.get('actor'), userId: u.id, email: u.email });
    return c.json({ gebruiker: u, nieuw: result.isNewUser, registratie: registratie ?? null });
  });

  v1.post('/auth/uitloggen', requireUser, async (c) => {
    await logout(p, c.get('session')!, c.get('actor'));
    deleteCookie(c, cookieName, { path: '/', secure: opts.secureCookies });
    return c.body(null, 204);
  });

  v1.post('/auth/overal-uitloggen', requireUser, async (c) => {
    const u = user(c);
    const n = await logoutEverywhere(p, u.userId, u);
    deleteCookie(c, cookieName, { path: '/', secure: opts.secureCookies });
    return c.json({ sessiesBeeindigd: n });
  });

  v1.get('/ik', requireUser, async (c) => {
    const s = c.get('session')!;
    return c.json({ gebruiker: s.user, organisaties: await listOrganizationsForUser(p, s.user.id) });
  });

  // Organisaties ----------------------------------------------------------------
  v1.post('/organisaties', requireUser, async (c) => {
    const input = await body(c, schemas.createOrg);
    return c.json(await createOrganization(p, user(c), input), 201);
  });
  v1.get('/organisaties/:org', requireUser, async (c) => c.json(await getOrganization(p, user(c).userId, param(c, 'org'))));
  v1.patch('/organisaties/:org', requireUser, async (c) => {
    const { name } = await body(c, schemas.renameOrg);
    return c.json(await renameOrganization(p, user(c), param(c, 'org'), name));
  });

  // Leden en uitnodigingen ----------------------------------------------------------
  v1.get('/organisaties/:org/leden', requireUser, async (c) => c.json(await listMembers(p, user(c).userId, param(c, 'org'))));
  v1.patch('/organisaties/:org/leden/:user', requireUser, async (c) => {
    const { role } = await body(c, schemas.changeRole);
    await changeMemberRole(p, user(c), param(c, 'org'), param(c, 'user'), role);
    return c.body(null, 204);
  });
  v1.delete('/organisaties/:org/leden/:user', requireUser, async (c) => {
    await removeMember(p, user(c), param(c, 'org'), param(c, 'user'));
    return c.body(null, 204);
  });
  // Contactpersonen (geen gebruikers: wie we bereiken bij een lek of een factuurvraag).
  v1.get('/organisaties/:org/contactpersonen', requireUser, async (c) => c.json(await listContacts(p, user(c).userId, param(c, 'org'))));
  v1.put('/organisaties/:org/contactpersonen/:soort', requireUser, async (c) => {
    const input = await body(c, schemas.contact);
    return c.json(await setContact(p, user(c), param(c, 'org'), c.req.param('soort') ?? '', input));
  });
  v1.delete('/organisaties/:org/contactpersonen/:soort', requireUser, async (c) => {
    await removeContact(p, user(c), param(c, 'org'), c.req.param('soort') ?? '');
    return c.body(null, 204);
  });

  v1.get('/organisaties/:org/uitnodigingen', requireUser, async (c) => c.json(await listInvitations(p, user(c).userId, param(c, 'org'))));
  v1.post('/organisaties/:org/uitnodigingen', requireUser, async (c) => {
    const input = await body(c, schemas.invite);
    return c.json(await inviteMember(p, user(c), param(c, 'org'), input), 201);
  });
  v1.delete('/organisaties/:org/uitnodigingen/:inv', requireUser, async (c) => {
    await revokeInvitation(p, user(c), param(c, 'org'), param(c, 'inv'));
    return c.body(null, 204);
  });
  v1.post('/uitnodigingen/accepteren', requireUser, async (c) => {
    const { token } = await body(c, schemas.token);
    return c.json(await acceptInvitation(p, user(c), token));
  });

  // IT-partners en klanten ------------------------------------------------------------
  v1.get('/organisaties/:org/klanten', requireUser, async (c) => c.json(await listClients(p, user(c).userId, param(c, 'org'))));
  v1.post('/organisaties/:org/klanten', requireUser, async (c) => {
    const input = await body(c, schemas.createClient);
    return c.json(await createClientForPartner(p, user(c), param(c, 'org'), input), 201);
  });
  v1.get('/organisaties/:org/partners', requireUser, async (c) => c.json(await listPartners(p, user(c).userId, param(c, 'org'))));
  v1.post('/organisaties/:org/partners', requireUser, async (c) => {
    const input = await body(c, schemas.grantPartner);
    return c.json(await grantPartnerAccess(p, user(c), param(c, 'org'), { partnerOrgId: input.partnerOrganizationId, access: input.access }), 201);
  });
  v1.delete('/organisaties/:org/partners/:partner', requireUser, async (c) => {
    await revokePartnerAccess(p, user(c), param(c, 'org'), param(c, 'partner'));
    return c.body(null, 204);
  });

  // Domeinen en verificatie -----------------------------------------------------------
  v1.get('/organisaties/:org/domeinen', requireUser, async (c) => c.json(await listDomains(p, user(c).userId, param(c, 'org'))));
  v1.post('/organisaties/:org/domeinen', requireUser, async (c) => {
    const input = await body(c, schemas.addDomain);
    return c.json(await addDomain(p, user(c), param(c, 'org'), input), 201);
  });
  v1.post('/organisaties/:org/domeinen/lijst', requireUser, async (c) => {
    const input = await body(c, z.object({ domeinen: z.union([z.string().max(5000), z.array(z.string().max(300)).max(100)]) }));
    const resultaten = await addDomains(p, user(c), param(c, 'org'), input.domeinen);
    const ongeldig = resultaten.filter((r) => r.status === 'ongeldig').map((r) => r.invoer);
    return c.json({
      aantal: resultaten.filter((r) => r.status === 'toegevoegd').length,
      bestaatAl: resultaten.filter((r) => r.status === 'bestaat_al').length,
      ongeldigTekst: ongeldig.join(', '),
      resultaten,
    }, 201);
  });
  v1.get('/organisaties/:org/domeinen/:dom', requireUser, async (c) =>
    c.json(await getDomain(p, user(c).userId, param(c, 'org'), param(c, 'dom'))),
  );
  v1.delete('/organisaties/:org/domeinen/:dom', requireUser, async (c) => {
    await removeDomain(p, user(c), param(c, 'org'), param(c, 'dom'));
    return c.body(null, 204);
  });
  v1.get('/organisaties/:org/domeinen/:dom/dns-beheer', requireUser, async (c) =>
    c.json(await findDnsHost(p, user(c).userId, param(c, 'org'), param(c, 'dom'))),
  );
  v1.post('/organisaties/:org/domeinen/:dom/verificatie/dns', requireUser, async (c) =>
    c.json(await verifyDomainByDns(p, user(c), param(c, 'org'), param(c, 'dom'))),
  );
  v1.post('/organisaties/:org/domeinen/:dom/verificatie/email', requireUser, async (c) => {
    const input = await body(c, schemas.emailVerify);
    // De web-app stuurt "ander" plus het zelf ingevulde adres.
    const address = input.address === 'ander' ? (input.eigenAdres ?? '') : input.address;
    await startEmailVerification(p, user(c), param(c, 'org'), param(c, 'dom'), address);
    return c.json({ bericht: `We hebben een bevestigingslink gestuurd naar ${address.trim().toLowerCase()}.` }, 202);
  });
  // Zonder inloggen: wie de beheermailbox leest, bevestigt.
  v1.post('/domeinverificatie/bevestigen', async (c) => {
    const { token } = await body(c, schemas.token);
    return c.json(await confirmEmailVerification(p, token, c.get('actor')));
  });

  // Scans -------------------------------------------------------------------------
  v1.post('/organisaties/:org/domeinen/:dom/scans', requireUser, async (c) => {
    const input = await body(c, schemas.scan);
    const opts = input.maxLevel === undefined ? {} : { maxLevel: input.maxLevel };
    return c.json(await requestScan(p, user(c), param(c, 'org'), param(c, 'dom'), opts), 202);
  });

  // Live voortgang van één scan (de scanpagina vraagt dit elke paar seconden op).
  v1.get('/organisaties/:org/scans/:scan', requireUser, async (c) => c.json(await getScan(p, user(c).userId, param(c, 'org'), param(c, 'scan'))));

  // Dashboard -------------------------------------------------------------------------
  v1.get('/organisaties/:org/dashboard', requireUser, async (c) => c.json(await getDashboard(p, user(c).userId, param(c, 'org'))));
  v1.get('/organisaties/:org/assets/:asset', requireUser, async (c) =>
    c.json(await getAssetDetail(p, user(c).userId, param(c, 'org'), param(c, 'asset'))),
  );
  v1.post('/organisaties/:org/demodata', requireUser, async (c) => {
    if (!demoDataAllowed()) return c.json({ fout: 'niet_gevonden', bericht: 'Deze pagina bestaat niet.' }, 404);
    return c.json(await seedDemoData(p, user(c), param(c, 'org')), 201);
  });

  // Pakketten, registratie en abonnement ---------------------------------------------
  v1.get('/abonnementen', (c) => c.json(publicCatalog(p.catalog)));

  v1.post('/registratie', async (c) => {
    const input = await body(c, schemas.signup);
    await registerSignup(p, { email: input.email, organizationName: input.organisatie, plan: input.pakket, interval: input.interval }, c.get('actor'));
    return c.json({ bericht: 'Check je mail: daar staat een link om je account te bevestigen en in te loggen.' }, 202);
  });

  v1.get('/organisaties/:org/abonnement', requireUser, async (c) => c.json(await getBilling(p, user(c).userId, param(c, 'org'))));
  v1.put('/organisaties/:org/abonnement', requireUser, async (c) => {
    const input = await body(c, schemas.subscription);
    const r = await changePlan(p, user(c), param(c, 'org'), { plan: input.pakket, interval: input.interval });
    return c.json({ ...r.subscription, wijziging: r.preview, betaling: r.payment ?? null, betaalpagina: r.checkoutUrl ?? null });
  });
  v1.get('/organisaties/:org/abonnement/voorbeeld', requireUser, async (c) =>
    c.json(await previewPlanChange(p, user(c).userId, param(c, 'org'), { plan: c.req.query('pakket') ?? '', interval: c.req.query('interval') ?? '' })),
  );
  v1.delete('/organisaties/:org/abonnement/geplande-wijziging', requireUser, async (c) => c.json(await cancelScheduledChange(p, user(c), param(c, 'org'))));
  v1.post('/organisaties/:org/abonnement/heractiveren', requireUser, async (c) => c.json(await resumeSubscription(p, user(c), param(c, 'org'))));
  v1.delete('/organisaties/:org/machtiging', requireUser, async (c) => {
    await revokeMandate(p, user(c), param(c, 'org'));
    return c.body(null, 204);
  });
  v1.post('/organisaties/:org/betaalwijze/factuur-aanvragen', requireUser, async (c) => {
    const { toelichting } = await body(c, schemas.invoiceRequest);
    await requestInvoicePayment(p, user(c), param(c, 'org'), toelichting);
    return c.body(null, 204);
  });
  v1.post('/organisaties/:org/abonnement/betalen', requireUser, async (c) => {
    const r = await checkoutSubscription(p, user(c), param(c, 'org'));
    return c.json({ betaling: r.payment, betaalpagina: r.checkoutUrl }, 201);
  });
  v1.post('/organisaties/:org/abonnement/opzeggen', requireUser, async (c) => {
    const input = await body(c, schemas.cancel);
    return c.json(await cancelSubscription(p, user(c), param(c, 'org'), input));
  });

  v1.post('/organisaties/:org/audit-opdrachten', requireUser, async (c) => {
    const input = await body(c, schemas.auditOrder);
    const r = await createAuditOrder(p, user(c), param(c, 'org'), { package: input.pakket, targetName: input.doelbedrijf, domains: input.domeinen });
    return c.json({ opdracht: r.orderId, betaling: r.payment, betaalpagina: r.checkoutUrl }, 201);
  });

  v1.get('/organisaties/:org/factuurgegevens', requireUser, async (c) => c.json(await getBillingDetails(p, user(c).userId, param(c, 'org'))));
  v1.put('/organisaties/:org/factuurgegevens', requireUser, async (c) => {
    const input = await body(c, schemas.billingDetails);
    const clean = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v ?? null]));
    return c.json(await updateBillingDetails(p, user(c), param(c, 'org'), clean));
  });
  v1.get('/organisaties/:org/facturen', requireUser, async (c) => c.json(await listInvoices(p, user(c).userId, param(c, 'org'))));
  v1.get('/organisaties/:org/facturen/:inv', requireUser, async (c) =>
    c.json(await getInvoice(p, user(c).userId, param(c, 'org'), param(c, 'inv'))),
  );

  // Betalingen ----------------------------------------------------------------------
  // Status opvragen haalt ook de actuele stand bij de provider op (na terugkomen van de betaalpagina).
  v1.get('/betalingen/:pay', requireUser, async (c) => {
    const pay = await getPayment(p, user(c).userId, param(c, 'pay'));
    return c.json(pay.status === 'open' ? { ...(await syncPayment(p, pay.id, user(c))), organizationId: pay.organizationId } : pay);
  });
  // Alleen bij testbetalingen (nep-provider); bij Mollie bestaat dit adres niet.
  v1.post('/organisaties/:org/betalingen/:pay/opnieuw', requireUser, async (c) => {
    const r = await retryPayment(p, user(c), param(c, 'org'), param(c, 'pay'));
    return c.json({ betaling: r.payment, betaalpagina: r.checkoutUrl }, 201);
  });
  v1.get('/organisaties/:org/betalingen', requireUser, async (c) =>
    c.json(await getBillingHistory(p, user(c).userId, param(c, 'org'), { zoek: c.req.query('zoek'), status: c.req.query('status'), jaar: c.req.query('jaar') })),
  );
  v1.post('/betalingen/:pay/test-uitkomst', requireUser, async (c) => {
    const { uitkomst } = await body(c, schemas.testPayment);
    return c.json(await settleTestPayment(p, user(c), param(c, 'pay'), uitkomst));
  });

  // Audit-log ---------------------------------------------------------------------
  v1.get('/organisaties/:org/audit', requireUser, async (c) => {
    const org = param(c, 'org');
    await authorize(p.pool, user(c).userId, org, 'audit:lezen');
    const before = c.req.query('voor');
    const limit = Number(c.req.query('aantal') ?? 50);
    const opts: { before?: string; limit?: number } = { limit: Number.isFinite(limit) ? limit : 50 };
    if (before && /^\d{1,18}$/.test(before)) opts.before = before;
    return c.json(await listAudit(p.pool, org, opts));
  });

  // Register bedrijfskritische systemen ----------------------------------------------
  v1.get('/organisaties/:org/systemen', requireUser, async (c) => c.json(await listSystemen(p, user(c).userId, param(c, 'org'))));
  v1.post('/organisaties/:org/systemen', requireUser, async (c) => {
    const input = await body(c, schemas.systeem);
    return c.json(await addSysteem(p, user(c), param(c, 'org'), input), 201);
  });
  v1.put('/organisaties/:org/systemen/:sys', requireUser, async (c) => {
    const input = await body(c, schemas.systeem);
    return c.json(await updateSysteem(p, user(c), param(c, 'org'), param(c, 'sys'), input));
  });
  v1.delete('/organisaties/:org/systemen/:sys', requireUser, async (c) => {
    await removeSysteem(p, user(c), param(c, 'org'), param(c, 'sys'));
    return c.body(null, 204);
  });

  // Koppelingen (testmodus) ---------------------------------------------------------
  // Alleen-lezen koppelingen met systemen van de klant. In deze versie wordt niets
  // echt verbonden: de stand staat in het geheugen (zie @qbicle/koppelingen).
  const koppelingen = teststandVoor(p);
  const koppelingId = (c: Context) => {
    const k = c.req.param('koppeling') ?? '';
    if (!KOPPELINGEN.some((x) => x.id === k)) throw new PlatformError('niet_gevonden', 'Deze koppeling bestaat niet.');
    return k;
  };
  const viaKoppeling = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof KoppelingFout)) throw err;
      const code = err.code === 'niet_gevonden' ? 'niet_gevonden' : err.code === 'verlopen' ? 'verlopen' : err.code === 'verkeerde_stap' ? 'conflict' : 'geen_toegang';
      throw new PlatformError(code, err.message);
    }
  };
  const huidigPakket = async (org: string) =>
    (await one<{ plan: string }>(
      p.pool,
      `SELECT plan FROM subscription WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd') LIMIT 1`,
      [org],
    ))?.plan ?? null;

  v1.get('/organisaties/:org/koppelingen', requireUser, async (c) => {
    const org = param(c, 'org');
    await authorize(p.pool, user(c).userId, org, 'org:lezen');
    return c.json({ testmodus: true, pakket: await huidigPakket(org), koppelingen: koppelingen.lijst(org) });
  });
  v1.post('/organisaties/:org/koppelingen/:koppeling/starten', requireUser, async (c) => {
    const org = param(c, 'org');
    const k = koppelingId(c);
    await authorize(p.pool, user(c).userId, org, 'domeinen:beheren');
    const plan = await huidigPakket(org);
    return c.json(viaKoppeling(() => koppelingen.starten(org, k, plan, user(c).email)));
  });
  v1.post('/organisaties/:org/koppelingen/:koppeling/deellink', requireUser, async (c) => {
    const org = param(c, 'org');
    const k = koppelingId(c);
    await authorize(p.pool, user(c).userId, org, 'domeinen:beheren');
    const link = viaKoppeling(() => koppelingen.deelLink(org, k, user(c).email));
    return c.json({ link: `${p.config.appOrigin}/it/${link.token}`, verlooptOp: link.verlooptOp });
  });
  v1.post('/organisaties/:org/koppelingen/:koppeling/test-toestemming', requireUser, async (c) => {
    const org = param(c, 'org');
    const k = koppelingId(c);
    await authorize(p.pool, user(c).userId, org, 'domeinen:beheren');
    const { uitkomst } = await body(c, schemas.testKoppeling);
    return c.json(viaKoppeling(() => koppelingen.testToestemming(org, k, uitkomst)));
  });
  v1.post('/organisaties/:org/koppelingen/:koppeling/intrekken', requireUser, async (c) => {
    const org = param(c, 'org');
    const k = koppelingId(c);
    await authorize(p.pool, user(c).userId, org, 'domeinen:beheren');
    return c.json(viaKoppeling(() => koppelingen.intrekken(org, k, user(c).email)));
  });
  v1.post('/organisaties/:org/koppelingen/:koppeling/interesse', requireUser, async (c) => {
    const org = param(c, 'org');
    const k = koppelingId(c);
    await authorize(p.pool, user(c).userId, org, 'org:lezen');
    return c.json(viaKoppeling(() => koppelingen.interesse(org, k)));
  });

  app.route('/api/v1', v1);
  return app;
}
