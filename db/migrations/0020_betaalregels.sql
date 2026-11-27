-- Factuurregels per betaling. Een verlenging kan nu meer regels hebben dan
-- alleen het pakket, bijvoorbeeld de add-on extra domeinen boven de limiet
-- (prijs: extraDomeinPerMaand in config/abonnementen.json, keuze Erik 27-11).
-- Zonder regels geldt de omschrijving als enige regel (zoals voorheen).

ALTER TABLE payment ADD COLUMN lines jsonb;
