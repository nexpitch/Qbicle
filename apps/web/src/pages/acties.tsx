/** @jsxImportSource hono/jsx */
import { FOR_WHO_LABELS, TASK_STATUS_LABELS, type Checklist, type ChecklistItem, type ChecklistSummary, type TaskLogEntry } from '@qbicle/platform';
import { FormError, Layout, Status, type NavOrg, type PageUser } from '../layout.tsx';
import { tijdstip } from './scan.tsx';

/**
 * Checklist: per actie vastleggen of hij is opgepakt en afgevinkt, door wie en
 * wanneer, met een notitie en aan wie hij is toegewezen. De volgende scan
 * controleert of het echt is opgelost. Zonder JavaScript werkt alles ook niet
 * (formulieren gaan via de JSON-API, zoals elders in de app).
 */

type Ctx = { user: PageUser; org: NavOrg };

type Kind = 'ok' | 'warn' | 'crit' | 'unk';

export function statusKind(i: Pick<ChecklistItem, 'status' | 'nogNietOpgelost'>): Kind {
  if (i.nogNietOpgelost) return 'crit';
  return ({ open: 'unk', bezig: 'warn', gedaan: 'ok', bevestigd: 'ok', genegeerd: 'unk' } as const)[i.status];
}

const LEVEL_LABEL: Record<string, string> = { crit: 'Urgent', warn: 'Aandacht', unk: 'Onbekend', ok: 'Opgelost' };

/** "3 van 7 acties gedaan" met balk; op het overzicht en bovenaan de checklist. */
export function ChecklistVoortgang(props: { s: ChecklistSummary; href?: string }) {
  const { s } = props;
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const delen = [
    s.bevestigd ? `${s.bevestigd} bevestigd door scan` : null,
    s.wachtOpScan ? `${s.wachtOpScan} wacht op de volgende scan` : null,
    s.nogNietOpgelost ? `${s.nogNietOpgelost} nog niet opgelost` : null,
    s.bezig ? `${s.bezig} opgepakt` : null,
    s.genegeerd ? `${s.genegeerd} bewust niet opgepakt` : null,
  ].filter(Boolean);
  return (
    <div class="checklist-voortgang stack-xs">
      <div class="row between">
        <strong>
          {s.done} van {s.total} {s.total === 1 ? 'actie' : 'acties'} gedaan
        </strong>
        {props.href ? (
          <a class="small" href={props.href}>
            Naar de checklist
          </a>
        ) : null}
      </div>
      <div class="voortgang" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Acties gedaan">
        <progress max={100} value={pct}></progress>
      </div>
      {delen.length ? <p class="small">{delen.join(' · ')}</p> : null}
    </div>
  );
}

function logText(l: TaskLogEntry): string {
  switch (l.kind) {
    case 'status':
      return `${l.fromStatus ? TASK_STATUS_LABELS[l.fromStatus] : 'Nog niet opgepakt'} → ${l.toStatus ? TASK_STATUS_LABELS[l.toStatus] : ''}${l.text ? `. Reden: ${l.text}` : ''}`;
    case 'notitie':
      return `Notitie: ${l.text ?? ''}`;
    case 'toewijzing':
      return `Toegewezen aan ${l.text ?? 'niemand'}`;
    default:
      return l.text ?? '';
  }
}

/** Wie deed wat wanneer, in één zin onder de titel. */
function Stand(props: { i: ChecklistItem }) {
  const { i } = props;
  if (i.nogNietOpgelost && i.stillSeenAt) {
    return (
      <p class="melding crit small">
        Afgevinkt{i.doneBy ? ` door ${i.doneBy}` : ''}, maar de scan van {tijdstip(i.stillSeenAt)} ziet het nog. Vraag wie het deed om het na te kijken, of
        start een nieuwe scan als het net is aangepast.
      </p>
    );
  }
  if (i.status === 'bevestigd') {
    return <p class="small">{i.confirmedAt ? `Bevestigd door de scan van ${tijdstip(i.confirmedAt)}.` : 'Bevestigd door scan.'}</p>;
  }
  if (i.status === 'gedaan') {
    return (
      <p class="small">
        Afgevinkt{i.doneBy ? ` door ${i.doneBy}` : ''}
        {i.doneAt ? ` op ${tijdstip(i.doneAt)}` : ''}. De volgende scan controleert of het echt is opgelost.
      </p>
    );
  }
  if (i.status === 'genegeerd') {
    return (
      <p class="small">
        Bewust niet opgepakt{i.updatedBy ? ` (${i.updatedBy})` : ''}. Reden: {i.reason}
      </p>
    );
  }
  if (i.status === 'bezig') {
    return <p class="small">Opgepakt{i.updatedBy ? ` door ${i.updatedBy}` : ''}{i.updatedAt ? ` op ${tijdstip(i.updatedAt)}` : ''}.</p>;
  }
  return null;
}

function Item(props: { i: ChecklistItem; orgId: string; mag: boolean }) {
  const { i, orgId } = props;
  const api = `/api/v1/organisaties/${orgId}/acties/${i.key}`;
  const klaar = i.status === 'bevestigd';
  return (
    <li class={`checklist-item${klaar ? ' is-klaar' : ''}`} id={`actie-${i.key}`}>
      <div class="row between">
        <Status kind={statusKind(i)}>{i.statusLabel}</Status>
        {i.findingCount ? <span class={`small lvl-${i.level}`}>{LEVEL_LABEL[i.level]}</span> : null}
      </div>
      <h3>{i.title}</h3>
      {i.why ? <p class="small">{i.why}</p> : null}
      <div class="row tags">
        <span class="badge">{FOR_WHO_LABELS[i.forWho]}</span>
        {i.assignedTo || i.assigneeName ? (
          <span class="badge">
            Toegewezen: {i.assignedTo ? FOR_WHO_LABELS[i.assignedTo].replace(/^Voor je |^Kun je /, '') : ''}
            {i.assigneeName ? `${i.assignedTo ? ', ' : ''}${i.assigneeName}` : ''}
          </span>
        ) : null}
        {i.assets.slice(0, 3).map((x) => (
          <a class="tag" href={`/o/${orgId}/assets/${x.id}`}>
            {x.label}
          </a>
        ))}
        {i.assets.length > 3 ? <span class="small">en {i.assets.length - 3} meer</span> : null}
      </div>
      <Stand i={i} />
      {i.note ? <p class="small notitie">Notitie: {i.note}</p> : null}

      {props.mag && !klaar ? (
        <div class="row">
          {i.status !== 'gedaan' ? (
            <form data-api={api}>
              <FormError />
              <input type="hidden" name="status" value="gedaan" />
              <button class="btn" type="submit">
                Afvinken: dit is gedaan
              </button>
            </form>
          ) : null}
          {i.status === 'open' ? (
            <form data-api={api}>
              <input type="hidden" name="status" value="bezig" />
              <button class="btn secondary" type="submit">
                Ik pak het op
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {props.mag && !klaar ? (
        <details class="more">
          <summary>Notitie, toewijzen of bewust niet oppakken</summary>
          <form data-api={api} class="stack-sm">
            <FormError />
            <fieldset class="stack-xs">
              <legend>Status</legend>
              {(['open', 'bezig', 'gedaan', 'genegeerd'] as const).map((st) => (
                <label class="radio">
                  <input type="radio" name="status" value={st} checked={i.status === st} /> {TASK_STATUS_LABELS[st]}
                </label>
              ))}
            </fieldset>
            <label>
              Reden (nodig bij "bewust niet opgepakt")
              <textarea name="reason" rows={2} maxlength={2000}>
                {i.reason ?? ''}
              </textarea>
            </label>
            <label>
              Toewijzen aan
              <select name="assignedTo">
                <option value="" selected={!i.assignedTo}>
                  Niemand
                </option>
                <option value="zelf" selected={i.assignedTo === 'zelf'}>
                  Zelf
                </option>
                <option value="it-partner" selected={i.assignedTo === 'it-partner'}>
                  IT-partner
                </option>
                <option value="webbouwer" selected={i.assignedTo === 'webbouwer'}>
                  Webbouwer
                </option>
              </select>
            </label>
            <label>
              Naam van wie het oppakt (optioneel)
              <input name="assigneeName" maxlength={200} value={i.assigneeName ?? ''} placeholder="Bijvoorbeeld: Jan, IT-Bedrijf BV" />
            </label>
            <label>
              Notitie (optioneel)
              <textarea name="note" rows={2} maxlength={2000} placeholder="Wat is er gedaan, of wat is afgesproken?">
                {i.note ?? ''}
              </textarea>
            </label>
            <button class="btn secondary" type="submit">
              Opslaan
            </button>
          </form>
        </details>
      ) : null}

      {i.log.length ? (
        <details class="more">
          <summary>Logboek ({i.log.length})</summary>
          <ol class="logboek">
            {i.log.map((l) => (
              <li>
                <span class="small muted">
                  {tijdstip(l.at)} · {l.who ?? 'Qbicle-scan'}
                </span>
                <span>{logText(l)}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}

export function ActiesPage(props: Ctx & { c: Checklist }) {
  const { c, org } = props;
  const todo = c.items.filter((i) => i.status !== 'bevestigd');
  const done = c.items.filter((i) => i.status === 'bevestigd');
  return (
    <Layout title="Acties" user={props.user} org={org} active="acties">
      <div class="intro">
        <p class="small">
          <a href={`/o/${org.id}/overzicht`}>Overzicht</a> / Acties
        </p>
        <h1>Checklist</h1>
        <p class="lead">
          Vink af wat is opgepakt. De volgende scan controleert of het echt is opgelost. Alles wat je hier doet, komt met naam en tijd in het logboek.
        </p>
      </div>
      <section class="card stack">
        {c.summary.total || c.summary.genegeerd ? <ChecklistVoortgang s={c.summary} /> : <p class="melding ok">Er staan geen acties open.</p>}
        {!c.magBijwerken ? <p class="small muted">Je kunt meekijken. Afvinken kan een beheerder of de eigenaar.</p> : null}
        {todo.length ? (
          <ol class="checklist">
            {todo.map((i) => (
              <Item i={i} orgId={org.id} mag={c.magBijwerken} />
            ))}
          </ol>
        ) : null}
      </section>
      {done.length ? (
        <section class="card stack">
          <h2>Opgelost en bevestigd</h2>
          <p class="small">Wat de scan niet meer ziet, blijft hier 90 dagen staan.</p>
          <ol class="checklist">
            {done.map((i) => (
              <Item i={i} orgId={org.id} mag={c.magBijwerken} />
            ))}
          </ol>
        </section>
      ) : null}
    </Layout>
  );
}
