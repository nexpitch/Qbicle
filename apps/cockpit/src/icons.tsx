/** @jsxImportSource hono/jsx */

/** Eenvoudige lijn-iconen (24×24, kleur volgt de tekst). */
const PATHS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5', 'M10 21v-6h4v6'],
  bedrijf: ['M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16', 'M15 9h4a1 1 0 0 1 1 1v11', 'M3 21h18', 'M8 8h3', 'M8 12h3', 'M8 16h3'],
  gebruikers: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7.5', 'M18 14a6 6 0 0 1 4 7'],
  abonnement: ['M4 12a8 8 0 0 1 14-5.3L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-14 5.3L4 15', 'M4 20v-5h5'],
  incasso: ['M3 10h18', 'M5 10V20', 'M10 10V20', 'M14 10V20', 'M19 10V20', 'M2 21h20', 'M12 3 3 8h18Z'],
  factuur: ['M6 2h9l5 5v15H6Z', 'M14 2v6h6', 'M9 13h7', 'M9 17h5'],
  gebruik: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  gezondheid: ['M3 12h4l2-5 4 10 2-5h6'],
  support: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M5.6 5.6l4.3 4.3', 'M14.1 14.1l4.3 4.3', 'M18.4 5.6l-4.3 4.3', 'M9.9 14.1l-4.3 4.3'],
  agent: ['M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z', 'M12 4v4', 'M9 14h.01', 'M15 14h.01', 'M10 17h4'],
  audit: ['M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6Z', 'M9 12l2 2 4-4'],
  medewerkers: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21a8 8 0 0 1 16 0', 'M19 3l1 1 2-2'],
  zoek: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M21 21l-5-5'],
  uitloggen: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l-5-5 5-5', 'M5 12h11'],
  slot: ['M6 11h12v10H6Z', 'M8 11V7a4 4 0 0 1 8 0v4'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number }) {
  const s = props.size ?? 18;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {PATHS[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}
