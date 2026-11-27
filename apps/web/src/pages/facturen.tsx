/** @jsxImportSource hono/jsx */
import type { BillingHistory, HistoryRow } from '@qbicle/platform';
import { datum, euro, FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';
import { AccountNav } from './abonnement-beheer.tsx';

type Ctx = { user: PageUser; org: NavOrg };

export const STATUS_LABEL: Record<HistoryRow['status'], string> = {
  betaald: 'Betaald',
  deels_terugbetaald: 'Deels terugbetaald',
  terugbetaald: 'Terugbetaald',
  open: 'Wacht op betaling',
  mislukt: 'Mislukt',
  niet_betaald: 'Niet betaald',
  geannuleerd: 'Geannuleerd',
};

function RowStatus(props: { r: HistoryRow }) {
  const s = props.r.status;
  const kind = s === 'betaald' ? 'ok' : s === 'open' || s === 'deels_terugbetaald' ? 'warn' : s === 'mislukt' || (s === 'niet_betaald' && props.r.opnieuwBetalen) ? 'crit' : 'unk';
  return <Status kind={kind}>{STATUS_LABEL[s]}</Status>;
}

function RetryButton(props: { orgId: string; payId: string; label?: string }) {
  return (
    <form data-api={`/api/v1/organisaties/${props.orgId}/betalingen/${props.payId}/opnieuw`} data-next-veld="betaalpagina">
      <FormError />
      <button class="btn small-btn" type="submit">
        {props.label ?? 'Opnieuw betalen'}
      </button>
    </form>
  );
}

export function FacturenPage(
  props: Ctx & { h: BillingHistory; q: { zoek: string; status: string; jaar: string }; magBetalen: boolean },
) {
  const { h, org, q } = props;
  const filtered = Boolean(q.zoek || (q.status && q.status !== 'alle') || q.jaar);
  return (
    <Layout title="Facturen" user={props.user} org={org} active="account">
      <div class="intro">
        <h1>Facturen en betalingen</h1>
        <p class="lead">
          Alle betalingen en facturen op één plek. Download een factuur als pdf of alles in één keer voor je boekhouding.

        </p>
      </div>
      <AccountNav orgId={org.id} active="facturen" />

      {h.actieNodig.map((r) => (
        <div class="melding warn row between" role="alert">
          <span>
            <b>Je betaling van {euro(r.payment.amountInclCents)} is niet gelukt</b> ({r.payment.description}, {datum(r.payment.createdAt)}). Er is niets afgeschreven.
            {props.magBetalen ? ' Betaal opnieuw om je overzicht en controles te houden.' : ' Vraag de eigenaar van het account om opnieuw te betalen.'}
          </span>
          {props.magBetalen ? <RetryButton orgId={org.id} payId={r.payment.id} label="Nu betalen" /> : null}
        </div>
      ))}

      <section class="card">
        <form class="filters" method="get" action={`/o/${org.id}/facturen`}>
          <label class="grow">
            Zoeken
            <input type="search" name="zoek" value={q.zoek} placeholder="Factuurnummer of omschrijving" maxlength={100} />
          </label>
          <label>
            Status
            <select name="status">
              {[
                ['alle', 'Alle'],
                ['betaald', 'Betaald'],
                ['open', 'Wacht op betaling'],
                ['mislukt', 'Mislukt of niet betaald'],
                ['terugbetaald', 'Terugbetaald'],
              ].map(([v, l]) => (
                <option value={v} selected={(q.status || 'alle') === v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Jaar
            <select name="jaar">
              <option value="">Alle jaren</option>
              {h.jaren.map((j) => (
                <option value={String(j)} selected={q.jaar === String(j)}>
                  {j}
                </option>
              ))}
            </select>
          </label>
          <button class="btn secondary" type="submit">
            Toon
          </button>
          {filtered ? <a href={`/o/${org.id}/facturen`}>Wis filters</a> : null}
        </form>

        <div class="row between">
          <p class="small">
            {h.totaal.aantal} {h.totaal.aantal === 1 ? 'factuur' : 'facturen'}
            {q.jaar ? ` in ${q.jaar}` : ''}: {euro(h.totaal.exclCents)} excl. btw + {euro(h.totaal.vatCents)} btw = <b>{euro(h.totaal.inclCents)}</b>
          </p>
          <a class="btn secondary small-btn" href={`/o/${org.id}/facturen/export.csv${q.jaar ? `?jaar=${q.jaar}` : ''}`}>
            Download overzicht (csv)
          </a>
        </div>

        {h.rows.length === 0 ? (
          <p class="small">{filtered ? 'Niets gevonden met deze filters.' : 'Nog geen betalingen. Je eerste factuur komt na je eerste betaling.'}</p>
        ) : (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Factuur</th>
                  <th>Omschrijving</th>
                  <th>Status</th>
                  <th class="num">Bedrag incl. btw</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {h.rows.map((r) => (
                  <tr>
                    <td class="nowrap">{datum(r.payment.createdAt)}</td>
                    <td class="nowrap">{r.invoiceId ? <a href={`/o/${org.id}/facturen/${r.invoiceId}`}>{r.invoiceNumber}</a> : <span class="small">Nog geen factuur</span>}</td>
                    <td>{r.payment.description}</td>
                    <td>
                      <RowStatus r={r} />
                      {r.refundedCents > 0 ? <div class="small">{euro(r.refundedCents)} terug</div> : null}
                    </td>
                    <td class="num">{euro(r.payment.amountInclCents)}</td>
                    <td class="num">
                      {r.invoiceId ? (
                        <a href={`/o/${org.id}/facturen/${r.invoiceId}/pdf`} download>
                          Pdf
                        </a>
                      ) : r.status === 'open' && r.payment.checkoutUrl && props.magBetalen ? (
                        <a href={r.payment.checkoutUrl}>Betalen</a>
                      ) : r.opnieuwBetalen && props.magBetalen ? (
                        <RetryButton orgId={org.id} payId={r.payment.id} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p class="small">
        Klopt er iets niet op een factuur? Facturen kunnen we niet aanpassen; we maken dan een creditfactuur. Pas je gegevens aan bij{' '}
        <a href={`/o/${org.id}/account#bedrijf`}>Bedrijfsgegevens</a>; dat geldt voor nieuwe facturen.
      </p>
    </Layout>
  );
}

/** Csv voor de boekhouding (puntkomma, Nederlandse bedragen). */
export function facturenCsv(h: BillingHistory): string {
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const bedrag = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const head = ['Datum', 'Factuurnummer', 'Omschrijving', 'Status', 'Excl. btw', 'Btw', 'Incl. btw', 'Terugbetaald'];
  const lines = h.rows.map((r) =>
    [
      new Date(r.payment.createdAt).toISOString().slice(0, 10),
      r.invoiceNumber ?? '',
      r.payment.description,
      STATUS_LABEL[r.status],
      bedrag(r.payment.amountExclCents),
      bedrag(r.payment.vatCents),
      bedrag(r.payment.amountInclCents),
      bedrag(r.refundedCents),
    ]
      .map((v) => esc(String(v)).replace(/^[=+\-@]/, "'$&"))
      .join(';'),
  );
  return '﻿' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}
