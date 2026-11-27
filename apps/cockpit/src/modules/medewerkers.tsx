/** @jsxImportSource hono/jsx */
import { PlatformError } from '@qbicle/platform';
import { z } from 'zod';
import { can, STAFF_ROLE_LABEL, STAFF_ROLES } from '../core/roles.ts';
import { addStaff, changeStaffRole, listStaff, resetStaffMfa, revokeStaff } from '../core/staff.ts';
import { datum, datumTijd, FormError, Status } from '../layout.tsx';
import type { CockpitModule } from '../module.ts';

const schemas = {
  add: z.object({ email: z.string().max(254), rol: z.enum(STAFF_ROLES) }),
  rol: z.object({ rol: z.enum(STAFF_ROLES) }),
};

const uuid = z.uuid();
function userParam(v: string | undefined): string {
  if (!v || !uuid.safeParse(v).success) throw new PlatformError('niet_gevonden', 'Deze medewerker bestaat niet.');
  return v;
}

export const medewerkers: CockpitModule = {
  key: 'medewerkers',
  nav: [{ key: 'medewerkers', label: 'Medewerkers', href: '/medewerkers', icon: 'medewerkers', group: 'beheer', order: 20 }],
  register({ pages, api }, ctx) {
    pages.get('/medewerkers', async (c) => {
      const staff = c.get('staff');
      const mag = can(staff.role, 'medewerkers.beheren');
      const rows = await listStaff(ctx.cockpit);
      return ctx.page(c, {
        title: 'Medewerkers',
        active: 'medewerkers',
        eyebrow: 'Beheer',
        children: (
          <>
            <section class="card">
              <div class="card-head">
                <h2>Wie heeft toegang tot de cockpit</h2>
                <span class="small">MFA is verplicht. Rollen: beheerder (alles), financieel, support, lezer.</span>
              </div>
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Medewerker</th>
                      <th>Rol</th>
                      <th>MFA</th>
                      <th>Laatst ingelogd</th>
                      <th>Sinds</th>
                      {mag ? <th class="num">Acties</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const zelf = r.user_id === staff.user.id;
                      const actief = !r.revoked_at;
                      return (
                        <tr class={actief ? undefined : 'dim'}>
                          <td>
                            <b>{r.display_name || r.email}</b>
                            {r.display_name ? <span class="sub">{r.email}</span> : null}
                            {zelf ? <span class="tag">jij</span> : null}
                          </td>
                          <td>
                            {mag && actief && !zelf ? (
                              <form class="inline" data-api={`/api/medewerkers/${r.user_id}/rol`}>
                                <select name="rol" aria-label={`Rol van ${r.email}`}>
                                  {STAFF_ROLES.map((role) => (
                                    <option value={role} selected={role === r.role}>
                                      {STAFF_ROLE_LABEL[role]}
                                    </option>
                                  ))}
                                </select>
                                <button class="btn secondary sm" type="submit">
                                  Opslaan
                                </button>
                                <FormError />
                              </form>
                            ) : (
                              STAFF_ROLE_LABEL[r.role]
                            )}
                          </td>
                          <td>
                            {!actief ? (
                              <Status kind="unk">Ingetrokken</Status>
                            ) : r.mfa ? (
                              <Status kind="ok">Ingesteld</Status>
                            ) : (
                              <Status kind="warn">Nog instellen</Status>
                            )}
                          </td>
                          <td class="nowrap">{r.last_login_at ? datumTijd(r.last_login_at) : '—'}</td>
                          <td class="nowrap">{datum(r.created_at)}</td>
                          {mag ? (
                            <td class="num">
                              {actief && !zelf ? (
                                <div class="row end">
                                  <form data-api={`/api/medewerkers/${r.user_id}/mfa-reset`} data-bevestig={`Authenticator van ${r.email} resetten? Alle sessies worden beëindigd.`}>
                                    <button class="btn secondary sm" type="submit">
                                      MFA resetten
                                    </button>
                                  </form>
                                  <form data-api={`/api/medewerkers/${r.user_id}/intrekken`} data-bevestig={`Toegang van ${r.email} intrekken?`}>
                                    <button class="btn danger sm" type="submit">
                                      Intrekken
                                    </button>
                                    <FormError />
                                  </form>
                                </div>
                              ) : null}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {mag ? (
              <section class="card narrow">
                <h2>Medewerker toevoegen</h2>
                <form class="stack" data-api="/api/medewerkers">
                  <FormError />
                  <label>
                    E-mailadres
                    <input type="email" name="email" required autocomplete="off" />
                  </label>
                  <label>
                    Rol
                    <select name="rol">
                      {STAFF_ROLES.map((role) => (
                        <option value={role} selected={role === 'lezer'}>
                          {STAFF_ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p class="small">De medewerker logt in via de cockpit met dit adres en stelt bij de eerste keer een authenticator-app in.</p>
                  <div>
                    <button class="btn" type="submit">
                      Toevoegen
                    </button>
                  </div>
                </form>
              </section>
            ) : null}
          </>
        ),
      });
    });

    api.post('/medewerkers', async (c) => {
      ctx.require(c, 'medewerkers.beheren');
      const b = await ctx.body(c, schemas.add);
      const r = await addStaff(ctx.cockpit, b.email, b.rol, c.get('actor'));
      return c.json({ medewerker: r.userId }, 201);
    });
    api.post('/medewerkers/:id/rol', async (c) => {
      ctx.require(c, 'medewerkers.beheren');
      const id = userParam(c.req.param('id'));
      if (id === c.get('staff').user.id) throw new PlatformError('conflict', 'Je kunt je eigen rol niet wijzigen.');
      const b = await ctx.body(c, schemas.rol);
      await changeStaffRole(ctx.cockpit, id, b.rol, c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/medewerkers/:id/intrekken', async (c) => {
      ctx.require(c, 'medewerkers.beheren');
      await revokeStaff(ctx.cockpit, userParam(c.req.param('id')), c.get('actor'));
      return c.json({ ok: true });
    });
    api.post('/medewerkers/:id/mfa-reset', async (c) => {
      ctx.require(c, 'medewerkers.beheren');
      await resetStaffMfa(ctx.cockpit, userParam(c.req.param('id')), c.get('actor'));
      return c.json({ ok: true });
    });
  },
};
