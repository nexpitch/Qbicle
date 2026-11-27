/** @jsxImportSource hono/jsx */
import { createApi, SESSION_COOKIE, type ApiOptions } from '@qbicle/api/src/app.ts';
import { KoppelingFout, teststandVoor, vindKoppeling } from '@qbicle/koppelingen';
import {
  authenticate,
  authorize,
  one,
  getBilling,
  getInvoice,
  getOrganization,
  getPayment,
  listInvoices,
  listOrganizationsForUser,
  PlatformError,
  syncPayment,
  type Platform,
  type Session,
} from '@qbicle/platform';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  can,
  demoDataAllowed,
  domainImpact,
  domainOverview,
  findDnsHost,
  getAssetDetail,
  getDashboard,
  listDomains,
  resolveAccess,
} from '@qbicle/platform';
import { Layout } from './layout.tsx';
import { AssetPage, AssetsPage, DashboardPage, DomeinBeherenPage, DomeinenPage, koppelingenSectie, WaarStaatDomeinPage } from './pages/dashboard.tsx';
import { AanmeldenPage, CheckMailPage, InloggenPage, TokenPage } from './pages/aanmelden.tsx';
import {
  AbonnementPage,
  AuditBestellenPage,
  BetalingPage,
  FactuurPage,
  KiesOrganisatiePage,
  TestBetaalPage,
  WelkomPage,
} from './pages/abonnement.tsx';
import { ItStappenplanPage, KoppelingDetailPage, KoppelingenPage } from './pages/koppelingen.tsx';

/**
 * De web-app voor klanten (Licht-stijl). Server-side gerenderde pagina's;
 * wijzigingen gaan altijd via de JSON-API onder /api/v1, die hier in hetzelfde
 * proces draait. Zo is er één plek voor rechten en validatie, en staan app en
 * API op hetzelfde adres (cookie en CSRF-controle werken zonder uitzonderingen).
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface StaticFile {
  body: Uint8Array;
  type: string;
}

function loadStatic(): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const add = (name: string, path: string, type: string) => files.set(name, { body: readFileSync(path), type });
  add('app.css', join(here, 'static/app.css'), 'text/css; charset=utf-8');
  add('app.js', join(here, 'static/app.js'), 'text/javascript; charset=utf-8');
  add('woordmerk.png', join(here, 'static/woordmerk.png'), 'image/png');
  add('icoon.png', join(here, 'static/icoon.png'), 'image/png');
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

type Vars = { session: Session | undefined };

export function createWeb(p: Platform, opts: ApiOptions): Hono<{ Variables: Vars }> {
  const api = createApi(p, opts);
  const app = new Hono<{ Variables: Vars }>();
  const cookieName = opts.secureCookies ? SESSION_COOKIE : 'qbicle_sessie';
  const files = loadStatic();

  // De API in hetzelfde proces.
  app.all('/api/*', (c) => api.fetch(c.req.raw, c.env));

  app.get('/static/:name', (c) => {
    const f = files.get(c.req.param('name'));
    if (!f) return c.notFound();
    return c.body(f.body as Uint8Array<ArrayBuffer>, 200, {
      'content-type': f.type,
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
  });

  app.use('*', async (c, next) => {
    c.set('session', await authenticate(p, getCookie(c, cookieName)));
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    if (!c.res.headers.has('referrer-policy')) c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    if (err instanceof PlatformError && (err.code === 'niet_gevonden' || err.code === 'geen_toegang')) {
      return c.html(<NietGevonden user={c.get('session')?.user} />, 404);
    }
    console.error(err);
    return c.html(
      <Layout title="Er ging iets mis">
        <section class="card narrow">
          <h1>Er ging iets mis</h1>
          <p>Probeer het over een paar minuten opnieuw.</p>
        </section>
      </Layout>,
      500,
    );
  });
  app.notFound((c) => c.html(<NietGevonden user={c.get('session')?.user} />, 404));

  const needUser = (c: Context<{ Variables: Vars }>) => c.get('session');

  // Openbaar ----------------------------------------------------------------------
  app.get('/', (c) => c.redirect(c.get('session') ? '/overzicht' : '/aanmelden'));

  app.get('/aanmelden', (c) => {
    const q = c.req.query();
    const product = q.product === 'corporate' || q.product === 'audit' ? q.product : 'mkb';
    return c.html(
      <AanmeldenPage
        catalog={p.catalog}
        product={product}
        plan={q.pakket}
        interval={q.interval === 'maand' ? 'maand' : 'jaar'}
        user={c.get('session')?.user}
      />,
    );
  });
  app.get('/aanmelden/check-je-mail', (c) => c.html(<CheckMailPage />));
  app.get('/inloggen', (c) => c.html(<InloggenPage />));
  app.get('/inloggen/check-je-mail', (c) => c.html(<CheckMailPage />));
  app.get('/domein-bevestigen', (c) =>
    c.html(<TokenPage title="Domein bevestigen" api="/api/v1/domeinverificatie/bevestigen" next="/overzicht" />),
  );
  app.get('/inloggen/bevestigen', (c) => c.html(<TokenPage title="Inloggen" api="/api/v1/auth/inloggen" next="/overzicht" />));

  // Ingelogd ------------------------------------------------------------------------
  app.get('/overzicht', async (c) => {
    const s = needUser(c);
    if (!s) return c.redirect('/inloggen');
    const orgs = await listOrganizationsForUser(p, s.user.id);
    if (orgs.length === 1) return c.redirect(`/o/${orgs[0]!.id}/overzicht`);
    return c.html(<KiesOrganisatiePage user={s.user} orgs={orgs} />);
  });

  const withOrg = async (c: Context<{ Variables: Vars }>) => {
    const s = needUser(c);
    if (!s) return undefined;
    const org = await getOrganization(p, s.user.id, c.req.param('org') ?? '');
    return { s, org: { id: org.id, name: org.name }, user: s.user };
  };

  app.get('/o/:org/overzicht', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const [d, b, access] = await Promise.all([
      getDashboard(p, ctx.s.user.id, ctx.org.id),
      getBilling(p, ctx.s.user.id, ctx.org.id).catch(() => null),
      resolveAccess(p.pool, ctx.s.user.id, ctx.org.id),
    ]);
    const demo = demoDataAllowed() && Boolean(access && can(access, 'org:wijzigen'));
    const extra = [koppelingenSectie(koppelingen.lijst(ctx.org.id), await huidigPakket(ctx.org.id), `/o/${ctx.org.id}`)];
    return c.html(<DashboardPage user={ctx.user} org={ctx.org} d={d} b={b} demo={demo} extra={extra} />);
  });

  app.get('/o/:org/assets', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const d = await getDashboard(p, ctx.s.user.id, ctx.org.id);
    return c.html(<AssetsPage user={ctx.user} org={ctx.org} d={d} soort={c.req.query('soort')} />);
  });

  app.get('/o/:org/assets/:asset', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const a = await getAssetDetail(p, ctx.s.user.id, ctx.org.id, c.req.param('asset'));
    return c.html(<AssetPage user={ctx.user} org={ctx.org} a={a} />);
  });

  app.get('/o/:org/domeinen', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const [domains, access] = await Promise.all([listDomains(p, ctx.s.user.id, ctx.org.id), resolveAccess(p.pool, ctx.s.user.id, ctx.org.id)]);
    const magBeheren = Boolean(access && can(access, 'domeinen:beheren'));
    const overview = await domainOverview(p, ctx.s.user.id, ctx.org.id, domains);
    const q = c.req.query();
    const added = q.toegevoegd !== undefined ? { aantal: Number(q.toegevoegd) || 0, bestaatAl: Number(q.bestaat) || 0, ongeldig: (q.ongeldig ?? '').slice(0, 300) } : undefined;
    return c.html(
      <DomeinenPage user={ctx.user} org={ctx.org} domains={domains} magBeheren={magBeheren} sent={q.mail === 'verstuurd'} verwijderd={q.verwijderd?.slice(0, 300)} overview={overview} added={added} />,
    );
  });

  app.get('/o/:org/domeinen/:dom/beheren', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const access = await resolveAccess(p.pool, ctx.s.user.id, ctx.org.id);
    if (!access || !can(access, 'domeinen:beheren')) return c.redirect(`/o/${ctx.org.id}/domeinen`);
    const [impact, domains] = await Promise.all([domainImpact(p, ctx.s.user.id, ctx.org.id, c.req.param('dom')), listDomains(p, ctx.s.user.id, ctx.org.id)]);
    const overview = await domainOverview(p, ctx.s.user.id, ctx.org.id, domains);
    return c.html(<DomeinBeherenPage user={ctx.user} org={ctx.org} impact={impact} overview={overview} />);
  });

  app.get('/o/:org/domeinen/:dom/waar', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const r = await findDnsHost(p, ctx.s.user.id, ctx.org.id, c.req.param('dom'));
    return c.html(<WaarStaatDomeinPage user={ctx.user} org={ctx.org} domainId={c.req.param('dom')} r={r} />);
  });

  app.get('/o/:org/welkom', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const b = await getBilling(p, ctx.s.user.id, ctx.org.id);
    return c.html(<WelkomPage user={ctx.user} org={ctx.org} b={b} catalog={p.catalog} />);
  });

  app.get('/o/:org/abonnement', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const b = await getBilling(p, ctx.s.user.id, ctx.org.id);
    const invoices = await listInvoices(p, ctx.s.user.id, ctx.org.id);
    return c.html(<AbonnementPage user={ctx.user} org={ctx.org} b={b} catalog={p.catalog} invoices={invoices} />);
  });

  app.get('/o/:org/facturen/:inv', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const inv = await getInvoice(p, ctx.s.user.id, ctx.org.id, c.req.param('inv'));
    return c.html(<FactuurPage user={ctx.user} org={ctx.org} inv={inv} />);
  });

  app.get('/o/:org/audit/bestellen', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const b = await getBilling(p, ctx.s.user.id, ctx.org.id).catch(() => null);
    return c.html(
      <AuditBestellenPage user={ctx.user} org={ctx.org} packages={p.catalog.auditPackages} catalog={p.catalog} magBestellen={Boolean(b?.magBeheren)} />,
    );
  });

  // Koppelingen (testmodus) ------------------------------------------------------------
  const koppelingen = teststandVoor(p);
  const huidigPakket = async (org: string) =>
    (await one<{ plan: string }>(
      p.pool,
      `SELECT plan FROM subscription WHERE organization_id = $1 AND status IN ('proef', 'actief', 'achterstallig', 'opgezegd') LIMIT 1`,
      [org],
    ))?.plan ?? null;

  app.get('/o/:org/koppelingen', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    return c.html(<KoppelingenPage user={ctx.user} org={ctx.org} standen={koppelingen.lijst(ctx.org.id)} plan={await huidigPakket(ctx.org.id)} />);
  });

  app.get('/o/:org/koppelingen/:koppeling', async (c) => {
    const ctx = await withOrg(c);
    if (!ctx) return c.redirect('/inloggen');
    const k = vindKoppeling(c.req.param('koppeling'));
    if (!k) return c.html(<NietGevonden user={ctx.user} />, 404);
    const magWijzigen = await authorize(p.pool, ctx.s.user.id, ctx.org.id, 'domeinen:beheren').then(
      () => true,
      () => false,
    );
    return c.html(
      <KoppelingDetailPage user={ctx.user} org={ctx.org} k={k} s={koppelingen.get(ctx.org.id, k.id)} plan={await huidigPakket(ctx.org.id)} magWijzigen={magWijzigen} />,
    );
  });

  // Openbaar stappenplan voor de IT-beheerder. Geen inlog, geen klantgegevens; niet indexeren.
  app.get('/it/:token', (c) => {
    c.header('X-Robots-Tag', 'noindex');
    c.header('Referrer-Policy', 'no-referrer');
    try {
      const { koppeling, verlooptOp } = koppelingen.openDeelLink(c.req.param('token'));
      return c.html(<ItStappenplanPage k={koppeling} verlooptOp={verlooptOp} />);
    } catch (err) {
      if (!(err instanceof KoppelingFout)) throw err;
      return c.html(
        <Layout title="Link niet geldig" minimal>
          <section class="card narrow">
            <h1>{err.code === 'verlopen' ? 'Deze link is verlopen' : 'Deze link werkt niet'}</h1>
            <p>Vraag degene die je de link stuurde om een nieuwe te maken in Qbicle.</p>
          </section>
        </Layout>,
        err.code === 'verlopen' ? 410 : 404,
      );
    }
  });

  // Betalen ----------------------------------------------------------------------------
  app.get('/betalen/test/:pay', async (c) => {
    const s = needUser(c);
    if (!s) return c.redirect('/inloggen');
    if (p.payments.name !== 'nep') return c.notFound();
    const pay = await getPayment(p, s.user.id, c.req.param('pay'));
    const org = await getOrganization(p, s.user.id, pay.organizationId);
    return c.html(<TestBetaalPage user={s.user} org={{ id: org.id, name: org.name }} pay={pay} />);
  });

  app.get('/betaling/:pay', async (c) => {
    const s = needUser(c);
    if (!s) return c.redirect('/inloggen');
    let pay = await getPayment(p, s.user.id, c.req.param('pay'));
    if (pay.status === 'open') pay = { ...(await syncPayment(p, pay.id, { userId: s.user.id })), organizationId: pay.organizationId };
    const org = await getOrganization(p, s.user.id, pay.organizationId);
    const invoice = pay.status === 'betaald' ? (await listInvoices(p, s.user.id, org.id)).find((i) => i.paymentId === pay.id) : undefined;
    return c.html(<BetalingPage user={s.user} org={{ id: org.id, name: org.name }} pay={pay} invoice={invoice} />);
  });

  return app;
}

function NietGevonden(props: { user?: { email: string } | undefined }) {
  return (
    <Layout title="Niet gevonden" user={props.user}>
      <section class="card narrow">
        <h1>Deze pagina bestaat niet</h1>
        <p>
          Of je hebt er geen toegang toe. <a href="/">Terug naar de start</a>.
        </p>
      </section>
    </Layout>
  );
}
