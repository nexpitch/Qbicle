/** @jsxImportSource hono/jsx */
import { Empty } from '../layout.tsx';
import type { CockpitModule, NavItem } from '../module.ts';

/**
 * Onderdeel dat nog gebouwd wordt: staat al in het menu, met een korte uitleg
 * wat er komt. Vervang de regel in modules/index.ts door de echte module.
 */
export function placeholder(item: Omit<NavItem, 'soon'>, wat: string[]): CockpitModule {
  return {
    key: item.key,
    nav: [{ ...item, soon: true }],
    register({ pages }, ctx) {
      pages.get(item.href, (c) =>
        ctx.page(c, {
          title: item.label,
          active: item.key,
          eyebrow: 'Binnenkort',
          children: (
            <section class="card">
              <Empty title="Dit onderdeel wordt nu gebouwd">Wat hier komt:</Empty>
              <ul class="todo">
                {wat.map((w) => (
                  <li>{w}</li>
                ))}
              </ul>
            </section>
          ),
        }),
      );
    },
  };
}
