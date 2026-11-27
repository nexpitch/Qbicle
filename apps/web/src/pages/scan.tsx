/** @jsxImportSource hono/jsx */
import type { DomainScanInfo, ScanView } from '@qbicle/platform';
import { BANDS } from '@qbicle/score';
import { FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';

/**
 * Scans zichtbaar maken: per domein wanneer de laatste en de volgende scan is,
 * een knop om nu te scannen, en een pagina die live laat zien wat Qbicle doet.
 * De live weergave werkt met app.js (vraagt de voortgang elke 2 seconden op);
 * zonder JavaScript ververst de pagina zichzelf niet, maar laat hij wel de stand zien.
 */

type Ctx = { user: PageUser; org: NavOrg };

/** "dinsdag 2 december 2026 om 14:05" in Nederlandse tijd. */
export function tijdstip(d: Date | string): string {
  const x = new Date(d);
  const dag = x.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
  const tijd = x.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
  return `${dag} om ${tijd}`;
}

function bandLabel(key: string): string {
  return BANDS.find((b) => b.key === key)?.label ?? key;
}

/** Het blok onder een bevestigd domein op de pagina Domeinen. */
export function DomeinScanBlok(props: { orgId: string; domainId: string; info: DomainScanInfo | undefined; magScannen: boolean; workerActief: boolean }) {
  const { info, orgId } = props;
  if (!info) return null;
  return (
    <div class="scan-blok stack-sm">
      <dl class="facts">
        <dt>Laatste scan</dt>
        <dd>
          {info.last ? (
            <>
              {tijdstip(info.last.finishedAt)}
              {info.last.urgency !== null ? <span class="muted"> · urgentie {info.last.urgency}</span> : null}
            </>
          ) : (
            'Nog niet gescand'
          )}
        </dd>
        <dt>Volgende scan</dt>
        <dd>
          {info.current ? (
            <strong>{info.current.status === 'bezig' ? 'Nu bezig' : 'Staat klaar, begint zo'}</strong>
          ) : info.next ? (
            tijdstip(info.next)
          ) : (
            'Niet automatisch gepland'
          )}
          <span class="hint">{info.nextText}</span>
        </dd>
      </dl>
      {!props.workerActief ? (
        <p class="melding warn">De scanner draait op dit moment niet. Een scan die je start, begint zodra hij weer draait.</p>
      ) : null}
      <div class="row">
        {info.current ? (
          <a class="btn" href={`/o/${orgId}/scans/${info.current.id}`}>
            Bekijk de scan die nu loopt
          </a>
        ) : props.magScannen ? (
          <form data-api={`/api/v1/organisaties/${orgId}/domeinen/${props.domainId}/scans`} data-next={`/o/${orgId}/scans/{id}`}>
            <FormError />
            <button class="btn" type="submit" disabled={Boolean(info.canStartAt)}>
              Scan nu starten
            </button>
            {info.canStartAt ? <span class="hint">Net gescand. Vanaf {tijdstip(info.canStartAt).split(' om ')[1]} kun je opnieuw scannen.</span> : null}
          </form>
        ) : null}
        {info.last ? (
          <a class="btn secondary" href={`/o/${orgId}/overzicht`}>
            Naar de resultaten
          </a>
        ) : null}
        {info.lastFailed ? (
          <a class="linkbtn" href={`/o/${orgId}/scans/${info.lastFailed.id}`}>
            Waarom lukte de vorige scan niet?
          </a>
        ) : null}
      </div>
    </div>
  );
}

const STEP_LABEL = { wachten: 'Wacht', bezig: 'Bezig', klaar: 'Klaar' } as const;
const STEP_KIND = { wachten: 'unk', bezig: 'warn', klaar: 'ok' } as const;

export function ScanPage(props: Ctx & { s: ScanView }) {
  const { s, org } = props;
  const lopend = s.status === 'wachtrij' || s.status === 'bezig';
  const titel =
    s.status === 'klaar'
      ? `Scan van ${s.domain} is klaar`
      : s.status === 'mislukt'
        ? `Scan van ${s.domain} is niet gelukt`
        : s.status === 'bezig'
          ? `Qbicle scant ${s.domain}`
          : `Scan van ${s.domain} staat klaar`;
  return (
    <Layout title={titel} user={props.user} org={org} active="domeinen">
      <div class="intro">
        <p class="small">
          <a href={`/o/${org.id}/overzicht`}>Overzicht</a> / <a href={`/o/${org.id}/domeinen`}>Domeinen</a> / Scan
        </p>
        <h1 data-scan-titel>{titel}</h1>
        <p class="lead">
          We kijken van buitenaf, zoals een gewone bezoeker of mailserver. We proberen niets uit en scannen geen poorten.
        </p>
      </div>
      <section
        class="card narrow scan-live stack"
        data-scan={`/api/v1/organisaties/${org.id}/scans/${s.id}`}
        data-scan-klaar={`/o/${org.id}/overzicht`}
        data-scan-status={s.status}
        aria-live="polite"
      >
        <div class="row between">
          <h2>{s.domain}</h2>
          <span data-scan-badge>
            {s.status === 'klaar' ? (
              <Status kind="ok">Klaar</Status>
            ) : s.status === 'mislukt' ? (
              <Status kind="crit">Niet gelukt</Status>
            ) : s.status === 'bezig' ? (
              <Status kind="warn">Bezig</Status>
            ) : (
              <Status kind="unk">In de wachtrij</Status>
            )}
          </span>
        </div>
        <div class="voortgang" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.pct} aria-label="Voortgang van de scan">
          <progress max={100} value={s.pct} data-scan-balk></progress>
        </div>
        <p class="small" data-scan-tekst>
          {s.status === 'wachtrij'
            ? s.workerActief
              ? 'De scan begint over een paar seconden.'
              : 'De scanner draait op dit moment niet. De scan begint zodra hij weer draait.'
            : s.status === 'bezig'
              ? 'Dit duurt meestal minder dan een minuut. Je kunt deze pagina open laten staan.'
              : s.status === 'klaar'
                ? `Klaar op ${tijdstip(s.finishedAt!)}.`
                : (s.error ?? 'De scan is niet gelukt.')}
        </p>
        <ol class="scan-stappen">
          {s.steps.map((st) => (
            <li data-stap={st.key} data-stap-status={st.status}>
              <div>
                <strong>{st.label}</strong>
                <span class="hint">{st.uitleg}</span>
              </div>
              <span data-stap-badge>
                <Status kind={STEP_KIND[st.status]}>{STEP_LABEL[st.status]}</Status>
              </span>
            </li>
          ))}
        </ol>
        <div class="melding ok" data-scan-resultaat hidden={!s.result}>
          {s.result ? (
            <>
              Urgentie <strong>{s.result.urgency}</strong> ({bandLabel(s.result.band)}),{' '}
              {s.result.openFindings === 1 ? 'één punt' : `${s.result.openFindings} punten`} om naar te kijken. We sturen je zo door naar het overzicht.
            </>
          ) : null}
        </div>
        <div class="row">
          <a class="btn" href={`/o/${org.id}/overzicht`} data-scan-naar hidden={s.status !== 'klaar'}>
            Bekijk de resultaten
          </a>
          <a class="btn secondary" href={`/o/${org.id}/domeinen`} hidden={lopend}>
            Terug naar domeinen
          </a>
        </div>
      </section>
    </Layout>
  );
}
