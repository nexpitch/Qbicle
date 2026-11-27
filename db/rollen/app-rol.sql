-- Aparte databaserol voor de applicaties (web, api, cockpit, worker).
--
-- Waarom: als de applicatie inlogt als eigenaar van de tabellen, kan wie de
-- applicatie overneemt de beveiliging van het audit-log uitzetten (trigger weg,
-- of SET qbicle.audit_onderhoud = 'aan' en verwijderen). Met deze rol kan de
-- applicatie het audit-log alleen lezen en aanvullen.
--
-- Eenmalig draaien als eigenaar/superuser, NA de migraties:
--   psql "$DATABASE_URL_EIGENAAR" -v wachtwoord="'...'" -f db/rollen/app-rol.sql
-- Daarna draaien web, api, cockpit en worker met DATABASE_URL op qbicle_app.
-- Migraties blijven draaien als eigenaar. Na elke nieuwe migratie dit script
-- opnieuw draaien (het is idempotent), zodat nieuwe tabellen rechten krijgen.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qbicle_app') THEN
    CREATE ROLE qbicle_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE qbicle_app WITH PASSWORD :wachtwoord;

SELECT format('GRANT CONNECT ON DATABASE %I TO qbicle_app', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO qbicle_app;

-- Gewone tabellen: lezen en schrijven.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qbicle_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO qbicle_app;

-- Audit-log: alleen lezen en toevoegen. Geen UPDATE, DELETE of TRUNCATE,
-- dus ook niet met qbicle.audit_onderhoud aan. Opschonen na de bewaartermijn
-- doet de eigenaar.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM qbicle_app;
GRANT SELECT, INSERT ON audit_log TO qbicle_app;

-- Migratiebeheer is voor de eigenaar.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM qbicle_app;
