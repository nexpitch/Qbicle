# Interne cockpit

De cockpit is het interne beheerscherm van Qbicle: klanten, gebruikers,
abonnementen, incasso's, facturen, gebruik, support en agents op één plek.
Uitgangspunt: agents doen het werk en bereiden acties voor, een medewerker
houdt overzicht en beslist bij wat geld of klanten raakt.

## Lokaal starten

In Terminal, in de map `qbicle`:

```bash
bash scripts/cockpit.sh
```

1. De eerste keer vraagt het script met welk e-mailadres je wilt inloggen. Dat adres wordt beheerder.
2. De browser opent `http://localhost:3100/inloggen`. Vul daar hetzelfde adres in.
3. De inloglink komt in je mail (als Brevo in `.env` staat) of in de Terminal, op de regel met `inloggen/bevestigen`. Open die link.
4. Scan de QR-code met een authenticator-app op je telefoon (Microsoft Authenticator, Google Authenticator, 1Password) en vul de code in.

Stoppen: Ctrl+C. Authenticator kwijt? `docker compose --profile cockpit run --rm --no-deps --entrypoint npx cockpit --no-install tsx apps/cockpit/src/cli.ts mfa-reset jij@voorbeeld.nl`

## Beveiliging

- Eigen proces en adres (productie: een eigen subdomein), eigen cookie (`__Host-qbicle_cockpit`, SameSite=Strict), eigen sessies (`staff_session`). Een klantsessie of klant-inloglink werkt hier niet.
- Alleen medewerkers in `staff_member`. Inloggen = inloglink per mail + verplichte TOTP-code. Pas na de code wordt de sessie volwaardig en krijgt hij een nieuw token.
- TOTP-geheimen versleuteld (AES-256-GCM, `QBICLE_SECRETS_KEYS`); een code werkt maar één keer.
- Sessie verloopt na 60 minuten niets doen en uiterlijk na 12 uur. Intrekken of MFA-reset beëindigt alle sessies direct.
- Elke wijziging als JSON vanaf de eigen herkomst (CSRF), strikte CSP, `noindex`.
- Elke beheeractie in het alleen-toevoegen `audit_log` met actor `medewerker:<id>` (acties `cockpit.*`, operationele onderdelen `ops.*`).

## Rollen

| Rol | Mag |
| --- | --- |
| beheerder | alles, ook medewerkers en agents |
| financieel | abonnementen, facturen, incasso's indienen |
| support | klanten en gebruikers helpen, supporttickets |
| lezer | alles bekijken |

Permissies staan in `apps/cockpit/src/core/roles.ts`. Er blijft altijd minstens één beheerder.

## Een onderdeel toevoegen

1. Maak `apps/cockpit/src/modules/<naam>.tsx` met een `CockpitModule` (zie `src/module.ts` en `modules/audit.tsx` als voorbeeld):
   - `nav`: menu-item(s) met groep, icoon en eventueel `permission`.
   - `register({ pages, api }, ctx)`: HTML-pagina's op `pages`, wijzigingen op `api` (komt onder `/api`).
   - `ctx.page(c, {...})` rendert in de lay-out, `ctx.require(c, 'permissie')` controleert de rol, `ctx.body(c, zodSchema)` valideert invoer, `c.get('actor')` gebruik je voor `audit()`.
2. Zet de module in `apps/cockpit/src/modules/index.ts` (vervang de placeholder als die er staat).

De shell regelt inloggen, MFA, CSRF en headers; modules zien alleen ingelogde medewerkers met MFA.

## Bouwvolgorde

1. Shell: inloggen met MFA, rollen, navigatie, overzicht, audit-log, medewerkers (deze stap).
2. Bedrijven en gebruikers: zoeken (naam, domein, e-mail, KvK), filteren op abonnementsstatus, detail met tabbladen, notities (alleen voor Qbicle, niet te wijzigen), gebruikers blokkeren met reden en overal uitloggen.
3. Abonnementen (filter op status en betaalwijze, MRR), facturen en betalingen (openstaand, betaald, mislukt, terugbetaald), en per klant de betaalwijze: automatische incasso (standaard) of factuur met termijn. Bij factuur is een reden verplicht; elke wijziging staat in het audit-log.
4. Incassobatch (migratie `0010`): een agent of geplande taak zet verlengingen klaar (`npm run cockpit:beheer -- incasso-klaarzetten`), alleen voor klanten met betaalwijze incasso. Jij controleert in de cockpit (regel uitsluiten of bedrag aanpassen, altijd met reden), valideert, en dient met één knop in. Indienen gebeurt nooit automatisch en kan maar één keer; dezelfde periode wordt nooit dubbel geïncasseerd. In testmodus zet je per regel de uitkomst (betaald, of mislukt met reden). Betaald verlengt het abonnement en maakt een factuur; mislukt zet het abonnement op achterstallig. Bij het klaarzetten gaat een geplande pakketwissel (downgrade of andere betaaltermijn) eerst in, komen extra domeinen boven de pakketlimiet als eigen factuurregel mee, en tellen bijbetalingen voor een upgrade niet als verlenging. Heeft de klant de machtiging ingetrokken, dan wordt die regel niet geïncasseerd en staat er meteen een betaalverzoek klaar onder *Mislukt*.
5. Mislukte incasso's (migratie `0011`, tab *Incasso's → Mislukt*): bij elke mislukte regel zet een agent meteen een voorstel klaar met reden en conceptmail. Eerste keer geen dekking: opnieuw incasseren. Storno: klant mailen. Mandaat ingetrokken of rekening opgeheven: betaalverzoek per mail (met `{betaallink}`). Drie keer mislukt in een half jaar: bellen. Jij voert het voorstel uit, kiest een andere actie (mail is aan te passen), of wijst het af met reden. Er gaat niets naar de klant zonder die klik, en alles staat in het audit-log. In testmodus zet je de uitkomst van de nieuwe betaling onder *Afgehandeld*.

Gebruik, gezondheid, support en agents worden parallel gebouwd (`packages/ops`).
