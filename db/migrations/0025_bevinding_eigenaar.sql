-- Wie kan een bevinding oplossen, per hostingtype (scoremodel v0.6, advies
-- "Wat kan de klant zelf doen? Bevindingen per hostingtype", akkoord Erik 27-11).
-- "platform": alleen de leverancier van het websiteplatform (Wix, Shopify ...) kan
-- het veranderen; zo'n bevinding telt niet mee en geeft geen taak, behalve een kapot
-- certificaat, geen https of een actief misbruikt lek.
-- Leeg = de doelgroep van de actie in het scoremodel (zoals vóór deze migratie).
ALTER TABLE finding
  ADD COLUMN IF NOT EXISTS owner text CHECK (owner IN ('zelf', 'it-partner', 'webbouwer', 'hosting', 'platform')),
  -- Naam van het platform of de hostingpartij, bijvoorbeeld "Wix" of "Strato".
  ADD COLUMN IF NOT EXISTS platform text CHECK (char_length(platform) <= 100);
