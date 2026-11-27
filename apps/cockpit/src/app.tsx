/** @jsxImportSource hono/jsx */
import { PlatformError, type Actor } from '@qbicle/platform';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { raw } from 'hono/html';
import QRCode from 'qrcode';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { can, type Permission } from './core/roles.ts';
import {
  authenticateStaff,
  logoutStaff,
  mfaSetupSecret,
  requestStaffLink,
  staffActor,
  staffLogin,
  verifyStaffMfa,
  type Cockpit,
  type StaffSession,
} from './core/staff.ts';
import { Bare, FormError, Shell } from './layout.tsx';
import type { CockpitEnv, CockpitModule, ModuleContext, NavItem } from './module.ts';
import { MODULES } from './modules/index.ts';

/**
 * De interne cockpit van Qbicle: één plek om klanten, abonnementen, incasso's,
 * gebruik, support en agents te overzien en waar nodig in te grijpen.
 *
 * Draait als eigen proces op een eigen adres (lokaal poort 3100), met een eigen
 * cookie en eigen sessies. Alleen medewerkers (staff_member) komen binnen, en
 * pas na een code uit hun authenticator-app.
 *
 * Beveiliging: strikte CSP zonder inline scripts of stijlen, SameSite=Strict-
 * cookie, elke wijziging als JSON vanaf de eigen herkomst (CSRF), sessie
 * verloopt na 60 minuten niets doen en uiterlijk na 12 uur, elke beheeractie
 * in het audit-log, geen indexering door zoekmachines.
 */

export interface CockpitOptions {
  secureCookies: boolean;
  trustProxy: boolean;
  /** Andere lijst modules (tests). */
  modules?: CockpitModule[];
}

export const COCKPIT_COOKIE = '__Host-qbicle_cockpit';
const DEV_COOKIE = 'qbicle_cockpit';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadStatic(): Map<string, { body: Uint8Array; type: string }> {
  const files = new Map<string, { body: Uint8Array; type: string }>();
  const add = (name: string, path: string, type: string) => files.set(name, { body: readFileSync(path), type });
  add('cockpit.css', join(here, 'static/cockpit.css'), 'text/css; charset=utf-8');
  add('cockpit.js', join(here, 'static/cockpit.js'), 'text/javascript; charset=utf-8');
  // Beeldmerk en lettertypen: dezelfde als de klantomgeving, van onze eigen server (AVG).
  add('woordmerk.png', join(here, '../../web/src/static/woordmerk.png'), 'image/png');
  add('icoon.png', join(here, '../../web/src/static/icoon.png'), 'image/png');
  add('inter.woff2', require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'), 'font/woff2');
  add('manrope.woff2', require.resolve('@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2'), 'font/woff2');
  return files;
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let data: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new PlatformError('ongeldige_invoer', 'De aanvraag is geen geldige JSON.');
    }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || 'invoer';
    throw new PlatformError('ongeldige_invoer', `Ongeldige waarde voor ${field}.`);
  }
  return parsed.data;
}

type ShellVars = { maybeStaff: StaffSession | undefined; baseActor: Actor };
type AppEnv = { Variables: ShellVars & Partial<CockpitEnv['Variables']> };

export function createCockpit(cockpit: Cockpit, opts: CockpitOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const cookieName = opts.secureCookies ? COCKPIT_COOKIE : DEV_COOKIE;
  const allowedOrigin = new URL(cockpit.config.origin).origin;
  const files = loadStatic();
  const modules = opts.modules ?? MODULES;
  const nav: NavItem[] = modules.flatMap((m) => m.nav);

  const setSession = (c: Context, token: string, expires: Date) =>
    setCookie(c, cookieName, token, { httpOnly: true, secure: opts.secureCookies, sameSite: 'Strict', path: '/', expires });
  const clearSession = (c: Context) => deleteCookie(c, cookieName, { path: '/', secure: opts.secureCookies });

  app.get('/static/:name', (c) => {
    const f = files.get(c.req.param('name'));
    if (!f) return c.notFound();
    return c.body(f.body as Uint8Array<ArrayBuffer>, 200, {
      'content-type': f.type,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
  });

  // Beveiligingsheaders, CSRF en sessie voor alles behalve statische bestanden.
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('origin') !== allowedOrigin) {
        return c.json({ fout: 'geen_toegang', bericht: 'Aanvraag van een onbekende herkomst geweigerd.' }, 403);
      }
      if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return c.json({ fout: 'ongeldige_invoer', bericht: 'Stuur de aanvraag als application/json.' }, 415);
      }
    }
    c.set('maybeStaff', await authenticateStaff(cockpit, getCookie(c, cookieName)));
    c.set('baseActor', { userId: null, ip: clientIp(c, opts.trustProxy), userAgent: c.req.header('user-agent') ?? null });
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    c.header('Cache-Control', 'no-store');
    if (opts.secureCookies) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  const isApi = (c: Context) => new URL(c.req.url).pathname.startsWith('/api/');

  app.onError((err, c) => {
    const pe = err instanceof PlatformError ? err : undefined;
    if (!pe) console.error(err);
    if (isApi(c)) {
      return pe
        ? c.json({ fout: pe.code, bericht: pe.message }, pe.status as 400)
        : c.json({ fout: 'serverfout', bericht: 'Er ging iets mis. Probeer het later opnieuw.' }, 500);
    }
    const status = pe?.code === 'niet_gevonden' || pe?.code === 'geen_toegang' ? 404 : pe ? pe.status : 500;
    return c.html(
      <Bare title="Er ging iets mis">
        <section class="card">
          <h1>{status === 404 ? 'Niet gevonden' : 'Er ging iets mis'}</h1>
          <p>{pe ? pe.message : 'Probeer het over een paar minuten opnieuw.'}</p>
          <p>
            <a href="/">Terug naar het overzicht</a>
          </p>
        </section>
      </Bare>,
      status as 404,
    );
  });

  // Inloggen ---------------------------------------------------------------------------
  app.get('/inloggen', (c) => {
    if (c.get('maybeStaff')?.mfa) return c.redirect('/');
    return c.html(
      <Bare title="Inloggen">
        <section class="card">
          <h1>Inloggen</h1>
          <p class="muted">Je krijgt een inloglink per e-mail. Daarna vraagt de cockpit om een code uit je authenticator-app.</p>
          <form class="stack" data-api="/api/inloglink" data-next="/inloggen/check-je-mail">
            <FormError />
            <label>
              Werk-e-mailadres
              <input type="email" name="email" required autocomplete="email" autofocus />
            </label>
            <button class="btn wide" type="submit">
              Stuur inloglink
            </button>
          </form>
        </section>
      </Bare>,
    );
  });

  app.get('/inloggen/check-je-mail', (c) =>
    c.html(
      <Bare title="Check je mail">
        <section class="card">
          <h1>Check je mail</h1>
          <p class="muted">Als dit adres toegang heeft tot de cockpit, staat er binnen een minuut een inloglink in je mail. De link werkt 15 minuten.</p>
          <p>
            <a href="/inloggen">Ander adres proberen</a>
          </p>
        </section>
      </Bare>,
    ),
  );

  app.get('/inloggen/bevestigen', (c) =>
    c.html(
      <Bare title="Inloggen">
        <section class="card" data-token-post="/api/inloggen" data-next="/mfa">
          <h1>Inloggen</h1>
          <p data-status role="status">
            Even geduld…
          </p>
          <noscript>
            <p class="form-fout">Zet JavaScript aan om deze link te gebruiken.</p>
          </noscript>
        </section>
      </Bare>,
    ),
  );

  app.post('/api/inloglink', async (c) => {
    const { email } = await readBody(c, z.object({ email: z.string().max(254) }));
    await requestStaffLink(cockpit, email, c.get('baseActor'));
    return c.json({ bericht: 'Als dit adres toegang heeft, staat er binnen een minuut een inloglink in je mail.' }, 202);
  });

  app.post('/api/inloggen', async (c) => {
    const { token } = await readBody(c, z.object({ token: z.string().max(200) }));
    const r = await staffLogin(cockpit, token, c.get('baseActor'));
    setSession(c, r.sessionToken, r.expiresAt);
    return c.json({ volgende: '/mfa' });
  });

  // MFA ---------------------------------------------------------------------------------
  app.get('/mfa', async (c) => {
    const s = c.get('maybeStaff');
    if (!s) return c.redirect('/inloggen');
    if (s.mfa) return c.redirect('/');
    if (!s.mfaConfigured) {
      const { secret, uri } = await mfaSetupSecret(cockpit, s);
      const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B2A3B', light: '#FFFFFF' } });
      return c.html(
        <Bare title="Authenticator instellen">
          <section class="card">
            <h1>Authenticator instellen</h1>
            <ol class="steps">
              <li>Open je authenticator-app (bijvoorbeeld Microsoft Authenticator, Google Authenticator of 1Password).</li>
              <li>Scan deze QR-code, of vul de sleutel hieronder met de hand in.</li>
              <li>Vul de code van 6 cijfers in die de app laat zien.</li>
            </ol>
            <div class="qr">{raw(svg)}</div>
            <p class="small center">
              Sleutel: <code class="secret">{secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            </p>
            <MfaForm />
          </section>
        </Bare>,
      );
    }
    return c.html(
      <Bare title="Code invullen">
        <section class="card">
          <h1>Code invullen</h1>
          <p class="muted">Ingelogd als {s.user.email}. Vul de code van 6 cijfers uit je authenticator-app in.</p>
          <MfaForm />
          <p class="small">
            Authenticator kwijt? Vraag een andere beheerder om je MFA te resetten.
          </p>
        </section>
      </Bare>,
    );
  });

  app.post('/api/mfa', async (c) => {
    const s = c.get('maybeStaff');
    if (!s) throw new PlatformError('niet_ingelogd', 'Log eerst in.');
    if (s.mfa) return c.json({ volgende: '/' });
    const { code } = await readBody(c, z.object({ code: z.string().max(12) }));
    const r = await verifyStaffMfa(cockpit, s, code, c.get('baseActor'));
    setSession(c, r.sessionToken, r.expiresAt);
    return c.json({ volgende: '/' });
  });

  app.post('/api/uitloggen', async (c) => {
    const s = c.get('maybeStaff');
    if (s) await logoutStaff(cockpit, s, c.get('baseActor'));
    clearSession(c);
    return c.body(null, 204);
  });

  // Alles hierna: alleen medewerkers met MFA ------------------------------------------------
  const guardPages: MiddlewareHandler<AppEnv> = async (c, next) => {
    const s = c.get('maybeStaff');
    if (!s) return c.redirect('/inloggen');
    if (!s.mfa) return c.redirect('/mfa');
    c.set('staff', s);
    c.set('actor', staffActor(s, c.get('baseActor')));
    await next();
  };
  const guardApi: MiddlewareHandler<AppEnv> = async (c, next) => {
    const s = c.get('maybeStaff');
    if (!s || !s.mfa) throw new PlatformError('niet_ingelogd', 'Log eerst in.');
    c.set('staff', s);
    c.set('actor', staffActor(s, c.get('baseActor')));
    await next();
  };

  const ctx: ModuleContext = {
    cockpit,
    page: (c, props) => c.html(<Shell {...props} staff={c.get('staff')} nav={nav} />),
    require: (c, permission: Permission) => {
      if (!can(c.get('staff').role, permission)) throw new PlatformError('geen_toegang', 'Je rol mag dit niet.');
    },
    body: (c, schema) => readBody(c, schema),
  };

  const pages = new Hono<CockpitEnv>();
  const api = new Hono<CockpitEnv>();
  for (const m of modules) m.register({ pages, api }, ctx);

  app.use('/api/*', guardApi);
  app.route('/api', api as unknown as Hono<AppEnv>);
  app.use('*', guardPages);
  app.route('/', pages as unknown as Hono<AppEnv>);

  app.notFound((c) =>
    isApi(c)
      ? c.json({ fout: 'niet_gevonden', bericht: 'Onbekend adres.' }, 404)
      : c.html(
          <Shell title="Niet gevonden" staff={c.get('staff')!} nav={nav} active="">
            <section class="card">
              <p>
                Deze pagina bestaat niet. <a href="/">Terug naar het overzicht</a>.
              </p>
            </section>
          </Shell>,
          404,
        ),
  );

  return app;
}

function MfaForm() {
  return (
    <form class="stack" data-api="/api/mfa" data-next="/">
      <FormError />
      <label>
        Code
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength={7} required autofocus class="code" />
      </label>
      <button class="btn wide" type="submit">
        Bevestigen
      </button>
    </form>
  );
}
