/** @jsxImportSource hono/jsx */
import { z } from 'zod';
import { blockUser, getUserDetail, listUsers, logoutUserEverywhere, unblockUser } from '../core/customers.ts';
import { can, isStaffRole, STAFF_ROLE_LABEL } from '../core/roles.ts';
import { ORG_KIND } from '../labels.tsx';
import { datum, datumTijd, Empty, FormError, Status } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';
import { actionLabel } from './audit.tsx';
import { idParam } from './klanten.tsx';

const STATUS = ['alle', 'geblokkeerd', 'nooit'] as const;
type UserFilter = (typeof STATUS)[number];
const STATUS_LABEL: Record<UserFilter, string> = { alle: 'Alle', geblokkeerd: 'Geblokkeerd', nooit: 'Nooit ingelogd' };
const PAGE = 50;

export const gebruikers: CockpitModule = {
  key: 'gebruikers',
  nav: [{ key: 'gebruikers', label: 'Gebruikers', href: '/gebruikers', icon: 'gebruikers', group: 'klanten', order: 20 }],
  register({ pages, api }, ctx) {
    pages.get('/gebruikers', async (c) => {
      const zoek = c.req.query('zoek') ?? '';
      const st = c.req.query('status');
      const status: UserFilter = (STATUS as readonly string[]).includes(st ?? '') ? (st as UserFilter) : 'alle';
      const pagina = Math.max(1, Number(c.req.query('pagina')) || 1);
      const { rows, total } = await listUsers(ctx.cockpit.p.pool, { zoek, status, limit: PAGE, offset: (pagina - 1) * PAGE });
      const link = (extra: Record<string, string>, f: UserFilter = status) => {
        const s = new URLSearchParams({ ...(zoek ? { zoek } : {}), ...(f !== 'alle' ? { status: f } : {}), ...extra }).toString();
        return s ? `/gebruikers?${s}` : '/gebruikers';
      };
      return ctx.page(c, {
        title: 'Gebruikers',
        active: 'gebruikers',
        eyebrow: 'Klanten',
        tabs: STATUS.map((k) => [STATUS_LABEL[k], link({}, k), k === status]),
        children: (
          <section class="card">
            <div class="card-head">
              <form class="filter" method="get" action="/gebruikers">
                {status !== 'alle' ? <input type="hidden" name="status" value={status} /> : null}
                <input type="search" name="zoek" value={zoek} placeholder="E-mail, naam of bedrijf" aria-label="Zoek gebruiker" />
                <button class="btn secondary sm" type="submit">
                  Zoeken
                </button>
              </form>
              <span class="small">{total === 1 ? '1 gebruiker' : `${total} gebruikers`}</span>
            </div>
            {rows.length === 0 ? (
              <Empty title="Geen gebruikers gevonden" />
            ) : (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Gebruiker</th>
                      <th>Bedrijven</th>
                      <th>Laatst ingelogd</th>
                      <th>Status</th>
                      <th>Sinds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr>
                        <td>
                          <a href={`/gebruikers/${u.id}`}>
                            <b>{u.display_name || u.email}</b>
                          </a>
                          {u.display_name ? <span class="sub">{u.email}</span> : null}
                          {u.staff_role ? <span class="tag">Qbicle</span> : null}
                        </td>
                        <td>{u.orgs ? u.org_names : <span class="muted">—</span>}</td>
                        <td class="nowrap">{u.last_login_at ? datumTijd(u.last_login_at) : 'Nooit'}</td>
                        <td>{u.disabled_at ? <Status kind="crit">Geblokkeerd</Status> : <Status kind="ok">Actief</Status>}</td>
                        <td class="nowrap">{datum(u.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {total > PAGE ? (
              <div class="row between">
                <span class="small">
                  Pagina {pagina} van {Math.ceil(total / PAGE)}
                </span>
                <div class="row">
                  {pagina > 1 ? <a class="btn secondary sm" href={link({ pagina: String(pagina - 1) })}>Vorige</a> : null}
                  {pagina * PAGE < total ? <a class="btn secondary sm" href={link({ pagina: String(pagina + 1) })}>Volgende</a> : null}
                </div>
              </div>
            ) : null}
          </section>
        ),
      });
    });

    pages.get('/gebruikers/:id', async (c) => {
      const id = idParam(c.req.param('id'), 'Deze gebruiker');
      const d = await getUserDetail(ctx.cockpit.p.pool, id);
      const mag = can(c.get('staff').role, 'klanten.beheren');
      const u = d.user;
      return ctx.page(c, {
        title: u.display_name || u.email,
        active: 'gebruikers',
        eyebrow: `Gebruiker sinds ${datum(u.created_at)}`,
        actions: u.disabled_at ? <Status kind="crit">Geblokkeerd</Status> : <Status kind="ok">Actief</Status>,
        children: (
          <>
            <div class="cols">
              <section class="card">
                <h2>Gegevens</h2>
                <dl class="facts">
                  <dt>E-mail</dt>
                  <dd>{u.email}</dd>
                  <dt>Laatst ingelogd</dt>
                  <dd>{u.last_login_at ? datumTijd(u.last_login_at) : 'Nooit'}</dd>
                  <dt>Open sessies</dt>
                  <dd>
                    {d.activeSessions}
                    {d.lastSeen ? `, laatst actief ${datumTijd(d.lastSeen)}` : ''}
                  </dd>
                  {u.staff_role && isStaffRole(u.staff_role) ? (
                    <>
                      <dt>Qbicle</dt>
                      <dd>Medewerker ({STAFF_ROLE_LABEL[u.staff_role]})</dd>
                    </>
                  ) : null}
                  {u.disabled_at ? (
                    <>
                      <dt>Geblokkeerd</dt>
                      <dd>
                        {datumTijd(u.disabled_at)}: {u.disabled_reason ?? 'geen reden vastgelegd'}
                      </dd>
                    </>
                  ) : null}
                </dl>
                <h2>Bedrijven</h2>
                {d.orgs.length === 0 ? (
                  <Empty title="Geen bedrijven" />
                ) : (
                  <ul class="feed">
                    {d.orgs.map((o) => (
                      <li>
                        <b>
                          <a href={`/klanten/${o.id}`}>{o.name}</a>
                        </b>
                        <span>
                          {o.role}
                          {o.kind !== 'klant' ? ` · ${ORG_KIND[o.kind] ?? o.kind}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {mag ? (
                <section class="card">
                  <h2>Acties</h2>
                  <form class="stack" data-api={`/api/gebruikers/${id}/uitloggen`} data-bevestig="Alle sessies van deze gebruiker beëindigen?">
                    <FormError />
                    <p class="small">Bijvoorbeeld na verlies van een laptop. De gebruiker kan daarna gewoon opnieuw inloggen.</p>
                    <div>
                      <button class="btn secondary" type="submit">
                        Overal uitloggen
                      </button>
                    </div>
                  </form>
                  {u.disabled_at ? (
                    <form class="stack" data-api={`/api/gebruikers/${id}/deblokkeren`} data-bevestig="Account weer toegang geven?">
                      <FormError />
                      <div>
                        <button class="btn" type="submit">
                          Deblokkeren
                        </button>
                      </div>
                    </form>
                  ) : (
                    <form class="stack" data-api={`/api/gebruikers/${id}/blokkeren`} data-bevestig="Account blokkeren? De gebruiker kan niet meer inloggen.">
                      <FormError />
                      <label>
                        Reden (komt in het audit-log)
                        <input type="text" name="reden" required maxlength={400} />
                      </label>
                      <div>
                        <button class="btn danger" type="submit">
                          Blokkeren
                        </button>
                      </div>
                    </form>
                  )}
                </section>
              ) : null}
            </div>
            <section class="card">
              <h2>Laatste activiteit</h2>
              {d.events.length === 0 ? (
                <Empty title="Nog geen activiteit" />
              ) : (
                <ul class="feed">
                  {d.events.map((e) => (
                    <li>
                      <b>
                        {actionLabel(e.action)}
                        {e.actor.startsWith('medewerker:') ? <span class="tag">Qbicle</span> : null}
                      </b>
                      <span>
                        {e.organization_name ? `${e.organization_name} · ` : ''}
                        {datumTijd(e.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ),
      });
    });

    api.post('/gebruikers/:id/blokkeren', async (c) => {
      ctx.require(c, 'klanten.beheren');
      const { reden } = await ctx.body(c, z.object({ reden: z.string().max(400) }));
      await blockUser(ctx.cockpit.p.pool, idParam(c.req.param('id'), 'Deze gebruiker'), reden, c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/gebruikers/:id/deblokkeren', async (c) => {
      ctx.require(c, 'klanten.beheren');
      await unblockUser(ctx.cockpit.p.pool, idParam(c.req.param('id'), 'Deze gebruiker'), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/gebruikers/:id/uitloggen', async (c) => {
      ctx.require(c, 'klanten.beheren');
      const n = await logoutUserEverywhere(ctx.cockpit.p.pool, idParam(c.req.param('id'), 'Deze gebruiker'), c.get('actor'));
      return c.json({ sessiesBeeindigd: n });
    });
  },
};
