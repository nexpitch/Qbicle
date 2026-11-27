import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Korte hash van app.css en app.js. De pagina's laden /static/app.js?v=<hash>, zodat
 * de browser na een update meteen de nieuwe versie haalt in plaats van een oude uit
 * zijn cache (anders werkt bijvoorbeeld de live scanvoortgang niet tot de cache verloopt).
 */
const here = dirname(fileURLToPath(import.meta.url));
const h = createHash('sha256');
for (const f of ['static/app.css', 'static/app.js']) h.update(readFileSync(join(here, f)));
export const STATIC_VERSION = h.digest('hex').slice(0, 10);
