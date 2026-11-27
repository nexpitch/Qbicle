/** @jsxImportSource hono/jsx */

/**
 * Kleine grafieken als inline SVG (geen scripts of style-attributen nodig, past
 * binnen de strikte CSP). Kleuren via CSS-klassen in cockpit.css.
 */

export function Bars(props: { points: Array<{ label: string; value: number }>; title: string; format: (n: number) => string }) {
  const w = 720;
  const h = 140;
  const pad = 18;
  const n = props.points.length || 1;
  const max = Math.max(...props.points.map((p) => p.value), 0);
  const bw = (w - pad * 2) / n;
  const total = props.points.reduce((a, p) => a + p.value, 0);
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${w} ${h + 22}`} role="img" aria-label={`${props.title}: totaal ${props.format(total)}`} preserveAspectRatio="none">
        <line class="chart-axis" x1={pad} x2={w - pad} y1={h} y2={h} />
        {props.points.map((p, i) => {
          const bh = max === 0 ? 0 : Math.max((p.value / max) * (h - 12), p.value > 0 ? 2 : 0);
          return (
            <g>
              <rect class="chart-bar" x={pad + i * bw + bw * 0.15} y={h - bh} width={bw * 0.7} height={bh} rx="2">
                <title>{`${p.label}: ${props.format(p.value)}`}</title>
              </rect>
              {i === 0 || i === n - 1 || (n > 10 && i === Math.floor(n / 2)) ? (
                <text class="chart-label" x={pad + i * bw + bw / 2} y={h + 16} text-anchor="middle">
                  {p.label.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
        {max > 0 ? (
          <text class="chart-label" x={pad} y={10}>
            {`max ${props.format(max)}`}
          </text>
        ) : null}
      </svg>
      <figcaption class="small">{props.title}</figcaption>
    </figure>
  );
}

/** Voortgangsbalk voor een limiet (0-100%+). */
export function Meter(props: { pct: number | null; tone: 'ok' | 'warn' | 'crit'; label: string }) {
  const pct = props.pct === null ? 0 : Math.min(props.pct, 100);
  return (
    <svg class="meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={props.label}>
      <rect class="meter-bg" x="0" y="0" width="100" height="8" rx="4" />
      <rect class={`meter-fill m-${props.tone}`} x="0" y="0" width={pct} height="8" rx="4" />
    </svg>
  );
}
