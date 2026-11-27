-- Opzegtermijn en stilzwijgende verlenging (Erik, 27-11-2026).
--
-- * Maand- en jaarabonnement: 1 maand opzegtermijn (instelbaar met
--   opzegtermijnMaanden in config/abonnementen.json).
-- * Wie opzegt, houdt het abonnement tot het einde van de eerste periode die
--   minstens één opzegtermijn na het opzeggen eindigt. Bij een jaarcontract dat
--   later dan een maand voor het einde wordt opgezegd, is dat dus na nog een jaar.
-- * subscription.ends_at is die einddatum. Ligt hij na current_period_end, dan
--   volgt er nog een verlenging (en incasso) tot ends_at. Zie needsRenewal().

ALTER TABLE subscription ADD COLUMN ends_at timestamptz;
