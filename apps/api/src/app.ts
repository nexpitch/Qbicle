import {
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
  ORG_KINDS,
  PARTNER_ACCESS,
  PlatformError,
  removeDomain,
  removeMember,
  renameOrganization,
  requestLoginLink,
  requestScan,
  revokeInvitation,
  revokePartnerAccess,
  ROLES,
  startEmailVerification,
  verifyDomainByDns,
  type Actor,
  type Platform,
  type Session,
} from '@qbicle/platform';
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
  createClient: z.object({ name: z.string().max(200) }),
  grantPartner: z.object({ partnerOrganizationId: id, access: z.enum(PARTNER_ACCESS).default('lezer') }),
  addDomain: z.object({ name: z.string().max(300) }),
  emailVerify: z.object({ address: z.string().max(320) }),
  scan: z.object({ maxLevel: z.union([z.literal(0), z.literal(1)]).optional() }),
};

function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    const first = xff?.split(',')[0]?.trim();
    if (first) return first;
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
    return c.json({ gebruiker: result.session.user, nieuw: result.isNewUser });
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
  v1.get('/organisaties/:org/domeinen/:dom', requireUser, async (c) =>
    c.json(await getDomain(p, user(c).userId, param(c, 'org'), param(c, 'dom'))),
  );
  v1.delete('/organisaties/:org/domeinen/:dom', requireUser, async (c) => {
    await removeDomain(p, user(c), param(c, 'org'), param(c, 'dom'));
    return c.body(null, 204);
  });
  v1.post('/organisaties/:org/domeinen/:dom/verificatie/dns', requireUser, async (c) =>
    c.json(await verifyDomainByDns(p, user(c), param(c, 'org'), param(c, 'dom'))),
  );
  v1.post('/organisaties/:org/domeinen/:dom/verificatie/email', requireUser, async (c) => {
    const { address } = await body(c, schemas.emailVerify);
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

  app.route('/api/v1', v1);
  return app;
}
