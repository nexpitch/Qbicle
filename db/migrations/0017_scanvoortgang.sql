-- Voortgang per stap tijdens het scannen (DNS, e-mail, certificaat, website),
-- voor de live weergave bij de klant. De scan-worker werkt dit bij.
ALTER TABLE scan ADD COLUMN IF NOT EXISTS progress jsonb;
